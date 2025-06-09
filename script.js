document.addEventListener('DOMContentLoaded', function() {
    const videoUrlInput = document.getElementById('videoUrl');
    const extractBtn = document.getElementById('extractBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const thumbnailImg = document.getElementById('thumbnail');
    const resolutionSpan = document.getElementById('resolution');
    const resultDiv = document.getElementById('result');
    const qualitySelector = document.getElementById('qualitySelector');
    const qualityInputs = document.querySelectorAll('input[name="quality"]');

    // Configuração para evitar CORS
    thumbnailImg.crossOrigin = 'Anonymous';

    extractBtn.addEventListener('click', extractThumbnail);
    downloadBtn.addEventListener('click', downloadThumbnail);
    videoUrlInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') extractThumbnail();
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

        // Carrega a qualidade padrão (maxresdefault)
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
        const url = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
        
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
            resultDiv.style.display = 'block';
            
        } catch (error) {
            console.error('Erro ao carregar:', error);
            alert(`❌ Thumbnail em "${quality}" não encontrada. Tente outra qualidade.`);
            resultDiv.style.display = 'none';
        }
    }

    // Faz o download da thumbnail como PNG
    async function downloadThumbnail() {
        const videoId = downloadBtn.dataset.videoId;
        const quality = downloadBtn.dataset.quality;
        
        if (!videoId || !quality) return;

        try {
            // Usa fetch para evitar problemas de CORS
            const response = await fetch(thumbnailImg.src);
            if (!response.ok) throw new Error('Falha ao baixar a imagem');
            
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            
            // Cria o link de download
            const link = document.createElement('a');
            link.href = blobUrl;
            link.download = `${videoId}-${quality}.png`;
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
