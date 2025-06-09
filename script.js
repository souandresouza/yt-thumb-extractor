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

    function extractVideoId(url) {
        const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
        const match = url.match(regExp);
        return (match && match[2].length === 11) ? match[2] : null;
    }

    async function extractThumbnail() {
        const videoUrl = videoUrlInput.value.trim();
        
        if (!videoUrl) {
            alert('Por favor, insira uma URL do YouTube');
            return;
        }
        
        const videoId = extractVideoId(videoUrl);
        if (!videoId) {
            alert('URL do YouTube inválida');
            return;
        }

        // Mostra o seletor de qualidade
        qualitySelector.style.display = 'block';
        resultDiv.style.display = 'none';
        downloadBtn.disabled = true;

        // Carrega a qualidade selecionada quando o usuário escolher
        const selectedQuality = document.querySelector('input[name="quality"]:checked').value;
        await loadThumbnail(videoId, selectedQuality);
    }

    // Monitora mudanças na seleção de qualidade
    qualityInputs.forEach(input => {
        input.addEventListener('change', async function() {
            const videoId = extractVideoId(videoUrlInput.value.trim());
            if (videoId) {
                await loadThumbnail(videoId, this.value);
            }
        });
    });

    async function loadThumbnail(videoId, quality) {
        const url = `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
        
        try {
            thumbnailImg.src = url;
            
            await new Promise((resolve, reject) => {
                thumbnailImg.onload = resolve;
                thumbnailImg.onerror = reject;
            });
            
            resolutionSpan.textContent = `${thumbnailImg.naturalWidth}x${thumbnailImg.naturalHeight}`;
            downloadBtn.disabled = false;
            downloadBtn.dataset.videoId = videoId;
            downloadBtn.dataset.quality = quality;
            resultDiv.style.display = 'block';
            
        } catch (error) {
            console.error('Erro ao carregar thumbnail:', error);
            alert(`Não foi possível carregar a thumbnail em ${quality}. Tente outra qualidade.`);
            resultDiv.style.display = 'none';
        }
    }

    async function downloadThumbnail() {
        const videoId = downloadBtn.dataset.videoId;
        const quality = downloadBtn.dataset.quality;
        
        if (!videoId || !quality) return;

        try {
            // Usando fetch para contornar problemas de CORS
            const response = await fetch(thumbnailImg.src);
            const blob = await response.blob();
            
            // Criar link de download
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${videoId}-${quality}.png`;
            document.body.appendChild(a);
            a.click();
            
            // Limpar
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
            
        } catch (error) {
            console.error('Erro ao baixar:', error);
            
            // Fallback para usuário: abrir em nova aba
            window.open(thumbnailImg.src, '_blank');
            alert('Não foi possível baixar diretamente. A imagem foi aberta em uma nova aba. Você pode salvá-la manualmente.');
        }
    }
});