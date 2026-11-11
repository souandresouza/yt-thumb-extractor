// script.js — extrator de thumbnails com validação de variantes, frames e PNG real.
document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    const videoUrlInput = document.getElementById('videoUrl');
    const extractBtn = document.getElementById('extractBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const thumbnailImg = document.getElementById('thumbnail');
    const resolutionSpan = document.getElementById('resolution');
    const sourceInfo = document.getElementById('sourceInfo');
    const resultDiv = document.getElementById('result');
    const qualitySelector = document.getElementById('qualitySelector');
    const qualityInputs = Array.from(document.querySelectorAll('input[name="quality"]'));
    const frameSelector = document.getElementById('frameSelector');
    const feedback = document.getElementById('feedback');

    const IMAGE_BASE = 'https://i.ytimg.com/vi';
    const CREATOR_ORDER = ['maxresdefault', 'hq720', 'sddefault', 'hqdefault', 'mqdefault', 'default'];
    const FRAME_PREFIXES = ['maxres', 'sd', 'hq', 'mq', ''];
    const DARK_LEVEL = 40;
    const MIN_BAR_PX = 6;
    const LOAD_TIMEOUT_MS = 15000;

    let requestToken = 0;
    let current = null;
    let activeObjectUrl = null;

    // ------------------------------------------------------------------
    // URL / ID
    // ------------------------------------------------------------------

    function isVideoId(value) {
        return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
    }

    function extractVideoId(input) {
        const text = (input || '').trim();
        if (!text) return null;
        if (isVideoId(text)) return text;

        let url;
        try {
            url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
        } catch (error) {
            return null;
        }

        const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');

        if (host === 'youtu.be') {
            const id = url.pathname.split('/').filter(Boolean)[0];
            return isVideoId(id) ? id : null;
        }

        if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
            if (url.pathname === '/watch') {
                const id = url.searchParams.get('v');
                return isVideoId(id) ? id : null;
            }

            const match = url.pathname.match(/\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
            return match ? match[1] : null;
        }

        const fallback = text.match(
            /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/|v\/))([A-Za-z0-9_-]{11})/
        );
        return fallback ? fallback[1] : null;
    }

    // ------------------------------------------------------------------
    // Carregamento e validação das variantes
    // ------------------------------------------------------------------

    async function loadImageViaFetch(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

        try {
            const response = await fetch(url, { mode: 'cors', signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);

            try {
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = () => reject(new Error('imagem inválida'));
                    img.src = objectUrl;
                });
                return { img, objectUrl, verified: true };
            } catch (error) {
                URL.revokeObjectURL(objectUrl);
                throw error;
            }
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('timeout');
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    function loadImageViaElement(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            let settled = false;
            const timer = setTimeout(() => finish(new Error('timeout')), LOAD_TIMEOUT_MS);

            function finish(error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                img.onload = null;
                img.onerror = null;
                if (error) reject(error);
                else resolve({ img, objectUrl: null, verified: false });
            }

            img.onload = () => finish(null);
            img.onerror = () => finish(new Error('falha ao carregar'));
            img.src = url;
        });
    }

    async function loadImage(url) {
        try {
            return await loadImageViaFetch(url);
        } catch (error) {
            // HTTP 404 e timeout são respostas definitivas; não vale tentar de novo.
            if (error.message === 'timeout' || /^HTTP \d+$/.test(error.message)) throw error;
            // Em file:// ou navegadores que bloqueiam fetch cross-origin, cai
            // para o carregamento por <img> (sem confirmação de status).
            return loadImageViaElement(url);
        }
    }

    function isUsableVariant(name, img, verified) {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        if (!width || !height) return false;

        // 120x90 é o placeholder de erro do YouTube (inclusive o corpo que vem
        // junto de um 404). Só aceita se for "default" e o status HTTP tiver
        // sido confirmado como 200.
        if (width <= 120 && height <= 90) {
            return verified && name === 'default';
        }
        return true;
    }

    function creatorCandidates(quality) {
        const index = CREATOR_ORDER.indexOf(quality);
        return CREATOR_ORDER.slice(index >= 0 ? index : 0);
    }

    function frameCandidates(frame) {
        return FRAME_PREFIXES.map((prefix) => (prefix ? `${prefix}${frame}` : String(frame)));
    }

    async function findImage(videoId, names, token) {
        const failures = [];

        for (const name of names) {
            if (token !== requestToken) throw new Error('cancelado');
            const url = `${IMAGE_BASE}/${videoId}/${name}.jpg`;

            try {
                const loaded = await loadImage(url);
                if (!isUsableVariant(name, loaded.img, loaded.verified)) {
                    if (loaded.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
                    failures.push(`${name}: placeholder 120x90`);
                    continue;
                }
                return { name, url, img: loaded.img, objectUrl: loaded.objectUrl };
            } catch (error) {
                failures.push(`${name}: ${error.message}`);
            }
        }

        throw new Error(`nenhuma variante válida (${failures.join('; ')})`);
    }

    // ------------------------------------------------------------------
    // Detecção de barras pretas (mesma heurística da CLI)
    // ------------------------------------------------------------------

    function detectBarBox(img) {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        if (width < 32 || height < 32) return null;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0);

        let data;
        try {
            data = ctx.getImageData(0, 0, width, height).data;
        } catch (error) {
            return null; // canvas contaminado por CORS
        }

        function isDark(offset) {
            return data[offset] <= DARK_LEVEL
                && data[offset + 1] <= DARK_LEVEL
                && data[offset + 2] <= DARK_LEVEL;
        }

        function rowIsDark(y) {
            let offset = y * width * 4;
            for (let x = 0; x < width; x += 1, offset += 4) {
                if (!isDark(offset)) return false;
            }
            return true;
        }

        function columnIsDark(x) {
            const stride = width * 4;
            let offset = x * 4;
            for (let y = 0; y < height; y += 1, offset += stride) {
                if (!isDark(offset)) return false;
            }
            return true;
        }

        let top = 0;
        while (top < height && rowIsDark(top)) top += 1;

        let bottom = 0;
        while (top + bottom < height && rowIsDark(height - 1 - bottom)) bottom += 1;

        let left = 0;
        while (left < width && columnIsDark(left)) left += 1;

        let right = 0;
        while (left + right < width && columnIsDark(width - 1 - right)) right += 1;

        if (top + bottom >= height || left + right >= width) return null;

        function symmetric(first, second) {
            return Math.abs(first - second) <= Math.max(3, Math.floor(0.12 * Math.max(first, second)));
        }

        const minVertical = Math.max(MIN_BAR_PX, Math.round(0.015 * height));
        const minHorizontal = Math.max(MIN_BAR_PX, Math.round(0.015 * width));

        if (!symmetric(top, bottom) || Math.min(top, bottom) < minVertical) {
            top = 0;
            bottom = 0;
        }
        if (!symmetric(left, right) || Math.min(left, right) < minHorizontal) {
            left = 0;
            right = 0;
        }

        if (top + bottom === 0 && left + right === 0) return null;
        if (top + bottom > 0.45 * height || left + right > 0.45 * width) return null;

        const croppedWidth = width - left - right;
        const croppedHeight = height - top - bottom;
        if (croppedWidth < 16 || croppedHeight < 16) return null;
        if ((croppedWidth * croppedHeight) / (width * height) < 0.4) return null;

        const ratio = croppedWidth / croppedHeight;
        if (ratio < 0.25 || ratio > 4) return null;

        return { x: left, y: top, width: croppedWidth, height: croppedHeight };
    }

    function cropToCanvas(img, box) {
        const canvas = document.createElement('canvas');
        canvas.width = box.width;
        canvas.height = box.height;
        canvas.getContext('2d').drawImage(
            img,
            box.x, box.y, box.width, box.height,
            0, 0, box.width, box.height
        );
        return canvas;
    }

    function imageToCanvas(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return canvas;
    }

    // ------------------------------------------------------------------
    // Interface
    // ------------------------------------------------------------------

    function setFeedback(message, type) {
        feedback.textContent = message || '';
        feedback.className = 'feedback';
        if (message) feedback.classList.add('visible', type || 'info');
    }

    function selectedQuality() {
        const checked = qualityInputs.find((input) => input.checked);
        return checked ? checked.value : 'maxresdefault';
    }

    function setQualityEnabled(enabled) {
        qualityInputs.forEach((input) => {
            input.disabled = !enabled;
            const label = input.closest('label');
            if (label) label.classList.toggle('disabled', !enabled);
        });
    }

    function resetResult() {
        if (activeObjectUrl) {
            URL.revokeObjectURL(activeObjectUrl);
            activeObjectUrl = null;
        }
        thumbnailImg.removeAttribute('src');
        resolutionSpan.textContent = '-';
        sourceInfo.textContent = '';
        resultDiv.style.display = 'none';
        downloadBtn.disabled = true;
        current = null;
    }

    async function loadThumbnail(videoId, token) {
        const frame = Number(frameSelector.value) || 0;
        const quality = selectedQuality();
        const frameFallback = { value: false };
        let found;

        setFeedback(frame ? `Carregando frame ${frame}...` : 'Buscando a melhor thumbnail...', 'info');

        if (frame) {
            try {
                found = await findImage(videoId, frameCandidates(frame), token);
            } catch (error) {
                if (token !== requestToken || error.message === 'cancelado') throw error;
                // Frame indisponível: cai para a thumb do criador.
                found = await findImage(videoId, creatorCandidates('maxresdefault'), token);
                frameFallback.value = true;
            }
        } else {
            found = await findImage(videoId, creatorCandidates(quality), token);
        }

        if (token !== requestToken) {
            if (found.objectUrl) URL.revokeObjectURL(found.objectUrl);
            throw new Error('cancelado');
        }

        let canvas;
        let displaySrc;
        let cropped = false;
        let objectUrl = found.objectUrl;

        try {
            const box = detectBarBox(found.img);

            if (box) {
                canvas = cropToCanvas(found.img, box);
                displaySrc = canvas.toDataURL('image/jpeg', 0.96);
                cropped = true;
                if (objectUrl) {
                    URL.revokeObjectURL(objectUrl);
                    objectUrl = null;
                }
            } else {
                canvas = imageToCanvas(found.img);
                displaySrc = objectUrl || found.url;
            }
        } catch (error) {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            throw error;
        }

        const source = frame && !frameFallback.value ? `Frame ${frame}` : 'Thumb do criador';
        const details = [source, found.name];

        if (cropped) details.push('barras pretas removidas');
        if (frameFallback.value) details.push(`frame ${frame} indisponível`);

        current = {
            videoId,
            variant: found.name,
            url: found.url,
            width: canvas.width,
            height: canvas.height,
            canvas,
            cropped,
            warning: frameFallback.value
                ? `O frame ${frame} não está disponível; usei a thumbnail do criador.`
                : '',
        };

        activeObjectUrl = objectUrl;
        thumbnailImg.src = displaySrc;
        thumbnailImg.alt = `Thumbnail ${found.name} do vídeo ${videoId}`;
        resolutionSpan.textContent = `${current.width}x${current.height}`;
        sourceInfo.textContent = details.join(' • ');
        resultDiv.style.display = 'block';
        downloadBtn.disabled = false;
    }

    async function extractThumbnail() {
        const videoUrl = videoUrlInput.value.trim();

        if (!videoUrl) {
            resetResult();
            setFeedback('Cole a URL de um vídeo do YouTube.', 'error');
            videoUrlInput.focus();
            return;
        }

        const videoId = extractVideoId(videoUrl);
        if (!videoId) {
            resetResult();
            setFeedback(
                'URL inválida. Formatos aceitos: youtube.com/watch?v=ID, youtu.be/ID, /shorts/ID, /live/ID ou /embed/ID.',
                'error'
            );
            return;
        }

        qualitySelector.style.display = 'block';
        resetResult();

        const token = ++requestToken;
        extractBtn.disabled = true;
        extractBtn.textContent = 'Buscando...';
        setFeedback('Buscando a melhor imagem disponível...', 'info');

        try {
            await loadThumbnail(videoId, token);
            if (token !== requestToken) return;
            if (current && current.warning) setFeedback(current.warning, 'info');
            else setFeedback('', '');
        } catch (error) {
            if (token !== requestToken || error.message === 'cancelado') return;
            console.warn('[yt-thumb] não foi possível carregar:', error.message);
            resetResult();
            setFeedback(
                'Não foi possível obter a thumbnail. O vídeo pode ser privado, removido ou não ter imagens disponíveis.',
                'error'
            );
        } finally {
            if (token === requestToken) {
                extractBtn.disabled = false;
                extractBtn.textContent = 'Extrair Thumbnail';
            }
        }
    }

    // ------------------------------------------------------------------
    // Download em PNG de verdade (canvas), com fallback para JPEG
    // ------------------------------------------------------------------

    function canvasToBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
            try {
                if (canvas.toBlob) {
                    canvas.toBlob(
                        (blob) => (blob ? resolve(blob) : reject(new Error('toBlob retornou vazio'))),
                        type,
                        quality
                    );
                    return;
                }

                const dataUrl = canvas.toDataURL(type, quality);
                const base64 = dataUrl.split(',')[1];
                const binary = atob(base64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
                resolve(new Blob([bytes], { type }));
            } catch (error) {
                reject(error);
            }
        });
    }

    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    async function downloadThumbnail() {
        if (!current) return;

        const originalText = downloadBtn.textContent;
        downloadBtn.disabled = true;
        downloadBtn.textContent = 'Gerando PNG...';

        try {
            const blob = await canvasToBlob(current.canvas, 'image/png');
            const suffix = current.cropped ? '-trim' : '';
            const filename = `thumbnail-${current.videoId}-${current.variant}-${current.width}x${current.height}${suffix}.png`;
            triggerDownload(blob, filename);
            setFeedback(`PNG salvo: ${filename}`, 'success');
        } catch (error) {
            console.error('[yt-thumb] falha ao gerar PNG:', error);
            try {
                const response = await fetch(current.url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = await response.blob();
                const filename = `thumbnail-${current.videoId}-${current.variant}.jpg`;
                triggerDownload(blob, filename);
                setFeedback('Não foi possível gerar o PNG; baixei o JPEG original.', 'info');
            } catch (fallbackError) {
                console.error('[yt-thumb] falha no fallback:', fallbackError);
                setFeedback('Não foi possível baixar a imagem. Abrindo em nova aba...', 'error');
                window.open(current.url, '_blank', 'noopener');
            }
        } finally {
            downloadBtn.disabled = false;
            downloadBtn.textContent = originalText;
        }
    }

    // ------------------------------------------------------------------
    // Eventos
    // ------------------------------------------------------------------

    extractBtn.addEventListener('click', extractThumbnail);
    downloadBtn.addEventListener('click', downloadThumbnail);

    videoUrlInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') extractThumbnail();
    });

    qualityInputs.forEach((input) => {
        input.addEventListener('change', () => {
            if (current) extractThumbnail();
        });
    });

    frameSelector.addEventListener('change', () => {
        const isFrame = frameSelector.value !== '0';
        setQualityEnabled(!isFrame);
        if (current) extractThumbnail();
    });

    // Estado inicial do seletor de qualidade.
    setQualityEnabled(true);
});
