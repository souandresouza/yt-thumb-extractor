document.addEventListener('DOMContentLoaded', function() {
    const videoUrlInput = document.getElementById('videoUrl');
    const extractBtn = document.getElementById('extractBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const thumbnailImg = document.getElementById('thumbnail');
    const resolutionSpan = document.getElementById('resolution');
    const resultDiv = document.getElementById('result');
    const qualitySelector = document.getElementById('qualitySelector');
    const qualityInputs = document.querySelectorAll('input[name="quality"]');
    const timeInput = document.getElementById('timeInput');
    const timeValue = document.getElementById('timeValue');

    // Configuração para evitar CORS
    thumbnailImg.crossOrigin = 'Anonymous';

    extractBtn.addEventListener('click', extractThumbnail);
    downloadBtn.addEventListener('click', downloadThumbnail);
    videoUrlInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') extractThumbnail();
    });

    // Atualiza o valor exibido do tempo
    timeInput.addEventListener('input', function() {
        timeValue.textContent = formatTime(this.value);
        // Atualiza a thumbnail se já tiver uma carregada
        const videoId = extractVideoId(videoUrlInput.value.trim());
        if (videoId && resultDiv.style.display === 'block') {
            loadThumbnail(videoId, document.querySelector('input[name="quality"]:checked').value);
        }
    });

    // Extrai o ID do vídeo (suporta watch, live, shorts, links curtos)
    function extractVideoId(url) {
        const patterns = [
            /youtu\.be\/([^#&?]{11})/, // youtu.be/ID
            /youtube\.com\/watch\?v=([^#&?]{11})/, // youtube.com/watch?v=ID
            /youtube\.com\/live\/([^#&?]{11})/, // youtube.com/live/ID
            /youtube\.com\/shorts\/([^#&?]{11})/ // youtube.com/shorts/ID
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) return match[1];
        }
        return null;
    }

    // Formata segundos para MM:SS
    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    // Converte tempo MM:SS para segundos
    function timeToSeconds(timeString) {
        const parts = timeString.split(':');
        if (parts.length === 2) {
            return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        }
        return parseInt(timeString);
    }

    // Extrai a thumbnail
    async function extractThumbnail() {
        const videoUrl = videoUrlInput.value.trim();
        
        if (!videoUrl) {
            alert('⚠️ Por favor, insira uma URL do YouTube');
            return;
        }
        
        const videoId = extractVideoId(videoUrl);
        if (!videoId) {
            alert('❌ URL inválida. Formatos aceitos:\n\n• youtube.com/watch?v=ID\n• youtube.com/live/ID\n• youtube.com/shorts/ID\n• youtu.be/ID');
            return;
        }

        // Mostra o seletor de qualidade
        qualitySelector.style.display = 'block';
        resultDiv.style.display = 'none';
        downloadBtn.disabled = true;

        // Carrega a thumbnail
        const selectedQuality = document.querySelector('input[name="quality"]:checked').value;
        await loadThumbnail(videoId, selectedQuality);
    }

    // Atualiza a thumbnail quando a qualidade é alterada
    qualityInputs.forEach(input => {
        input.addEventListener('change', async function() {
            const videoId = extractVideoId(videoUrlInput.value.trim());
            if (videoId) await loadThumbnail(videoId, this.value);
        });
    });

    // Carrega a thumbnail do YouTube
    async function loadThumbnail(videoId, quality) {
        let url;
        const timeInSeconds = timeInput.value;
        
        // Para thumbnails com tempo específico, usamos a API de sprites
        if (timeInSeconds > 0 && quality !== 'maxresdefault' && quality !== 'sddefault' && quality !== 'hqdefault') {
            // Calcula o número do sprite baseado no tempo (YouTube gera 4 thumbnails por sprite)
            const spriteNumber = Math.floor(timeInSeconds / 10);
            url = `https://img.youtube.com/vi/${videoId}/${quality}${spriteNumber}.jpg`;
        } else {
            // Thumbnails padrão sem tempo específico
            url = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
        }
        
        try {
            thumbnailImg.src = url;
            
            // Espera o carregamento da imagem
            await new Promise((resolve, reject) => {
                thumbnailImg.onload = resolve;
                thumbnailImg.onerror = () => reject(new Error('Thumbnail não encontrada'));
            });
            
            // Atualiza a interface
            resolutionSpan.textContent = `${thumbnailImg.naturalWidth}x${thumbnailImg.naturalHeight}`;
            downloadBtn.disabled = false;
            downloadBtn.dataset.videoId = videoId;
            downloadBtn.dataset.quality = quality;
            downloadBtn.dataset.time = timeInSeconds;
            resultDiv.style.display = 'block';
            
        } catch (error) {
            console.error('Erro ao carregar:', error);
            
            // Fallback: tenta carregar sem o tempo específico
            if (timeInSeconds > 0) {
                console.log('Tentando carregar sem tempo específico...');
                const fallbackUrl = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
                thumbnailImg.src = fallbackUrl;
                
                try {
                    await new Promise((resolve, reject) => {
                        thumbnailImg.onload = resolve;
                        thumbnailImg.onerror = reject;
                    });
                    
                    resolutionSpan.textContent = `${thumbnailImg.naturalWidth}x${thumbnailImg.naturalHeight}`;
                    downloadBtn.disabled = false;
                    downloadBtn.dataset.videoId = videoId;
                    downloadBtn.dataset.quality = quality;
                    downloadBtn.dataset.time = '0';
                    resultDiv.style.display = 'block';
                    
                    alert('⚠️ Thumbnail no tempo específico não encontrada. Mostrando thumbnail padrão.');
                    
                } catch (fallbackError) {
                    alert(`❌ Thumbnail em "${quality}" não encontrada. Tente outra qualidade.`);
                    resultDiv.style.display = 'none';
                }
            } else {
                alert(`❌ Thumbnail em "${quality}" não encontrada. Tente outra qualidade.`);
                resultDiv.style.display = 'none';
            }
        }
    }

    // Faz o download da thumbnail como PNG
    async function downloadThumbnail() {
        const videoId = downloadBtn.dataset.videoId;
        const quality = downloadBtn.dataset.quality;
        const time = downloadBtn.dataset.time;
        
        if (!videoId || !quality) return;

        try {
            // Usa fetch para evitar problemas de CORS
            const response = await fetch(thumbnailImg.src);
            if (!response.ok) throw new Error('Falha ao baixar a imagem');
            
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            
            // Cria o nome do arquivo com tempo
            const timeSuffix = time > 0 ? `-${formatTime(time).replace(':', 'm')}s` : '';
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = `${videoId}-${quality}${timeSuffix}.png`;
            document.body.appendChild(link);
            link.click();
            
            // Limpeza
            setTimeout(() => {
                document.body.removeChild(link);
                URL.revokeObjectURL(blobUrl);
            }, 100);
            
        } catch (error) {
            console.error('Erro no download:', error);
            
            // Fallback: abre em nova aba
            window.open(thumbnailImg.src, '_blank');
            alert('⚠️ Não foi possível baixar automaticamente. A imagem foi aberta em uma nova aba para salvar manualmente.');
        }
    }
});
