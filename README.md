# yt-thumb-extractor

Ferramentas para obter thumbnails de vídeos do YouTube em alta resolução:

- **`yt_thumb.py`** — CLI em Python que valida as variantes disponíveis, escolhe a
  maior imagem, remove barras pretas e pode remover logo/marca d'água.
- **`index.html`** — página web estática para consulta rápida no navegador.

## CLI (`yt_thumb.py`)

### O que ela faz

- Aceita URL completa, `youtu.be`, Shorts, live, embed, `music.youtube.com` ou o ID puro.
- Consulta **todas as variantes em paralelo** e valida cada resposta:
  - HTTP 404 / erro de rede;
  - assinatura e dimensões reais do JPEG;
  - placeholder cinza de 120x90 (quando o YouTube não tem a imagem).
- Deduplica imagens idênticas (ex.: `maxresdefault` e `hq720` costumam ser o mesmo arquivo).
- Escolhe a **maior imagem válida**; em caso de empate, prefere a thumb enviada pelo criador.
- **Remove barras pretas** de letterbox/pillarbox automaticamente (ImageMagick).
- Pode **remover uma região de logo/marca d'água** com o filtro `delogo` do ffmpeg.
- Salva todas as variantes com `--all` e metadados com `--json`.

### Requisitos

- Python 3.9+ (sem bibliotecas externas).
- Opcional: **ImageMagick** (`magick` ou `convert`) para cortar barras pretas.
- Opcional: **ffmpeg** para remover logo/marca d'água.

No Ubuntu/Debian:

```bash
sudo apt install imagemagick ffmpeg
```

### Uso

```bash
# melhor thumbnail
./yt_thumb.py "https://www.youtube.com/watch?v=bBcpeM7_Rrk"

# escolher diretório
./yt_thumb.py bBcpeM7_Rrk -o thumbs

# salvar todas as variantes válidas
./yt_thumb.py bBcpeM7_Rrk --all

# incluir frames automáticos do vídeo (1-3, hq1-3, maxres1-3, oar2/3)
./yt_thumb.py bBcpeM7_Rrk --all --frames

# remover um logo no canto inferior direito (22% da largura x 12% da altura)
./yt_thumb.py bBcpeM7_Rrk --delogo-corner br --delogo-size 22%x12%

# remover uma região exata (x,y,largura,altura em pixels)
./yt_thumb.py bBcpeM7_Rrk --delogo 1000,600,200,100

# vários vídeos a partir de um arquivo (uma URL/ID por linha)
./yt_thumb.py urls.txt -o thumbs
```

Saída de exemplo:

```
[1/1] https://www.youtube.com/watch?v=bBcpeM7_Rrk  (id: bBcpeM7_Rrk)
  ✓ maxresdefault  1280x720  [thumb do criador] -> ./thumbs/bBcpeM7_Rrk-maxresdefault-1280x720.jpg
  ignoradas: hq720 (duplicada), default (placeholder)
```

O nome do arquivo segue:

```
<ID>-<variante>-<largura>x<altura>[-trim][-nologo].jpg
```

### Ordem de qualidade (sem `--frames`)

| Ordem | Variante       | Tamanho típico | Observação                          |
|-------|----------------|----------------|-------------------------------------|
| 1     | `maxresdefault`| 1280x720       | melhor caso; pode não existir       |
| 2     | `hq720`        | 1280x720       | geralmente idêntica à anterior      |
| 3     | `sddefault`    | 640x480        | costuma ter barras (cortadas)       |
| 4     | `hqdefault`    | 480x360        | costuma ter barras (cortadas)       |
| 5     | `mqdefault`    | 320x180        | fallback                            |
| 6     | `default`      | 120x90         | só usada se não houver nada melhor  |

Com `--frames`, as variantes automáticas também entram e a **maior** vence por
área de pixels. Frames como `oar2`/`oar3` podem chegar a 1920x1080, mas podem ser
upscales do vídeo — vale comparar com `--all`.

### Opções

| Opção | Descrição |
|-------|-----------|
| `-o, --output DIR` | diretório de saída (padrão: `.`) |
| `--all` | salva todas as variantes válidas e únicas |
| `--frames` | inclui frames automáticos (`1-3`, `hq1-3`, `maxres1-3`, `oar2/3`) |
| `--no-trim` | não remove barras pretas |
| `--delogo X,Y,W,H` | remove logo/marca d'água na região (pixels) |
| `--delogo-corner {tl,tr,bl,br}` | remove logo no canto indicado |
| `--delogo-size WxH` | tamanho do logo para `--delogo-corner` (padrão `20%x12%`) |
| `--json` | imprime metadados em JSON no stdout (logs vão para stderr) |
| `--timeout S` | timeout por requisição (padrão: 20 s) |
| `--retries N` | tentativas extras por requisição (padrão: 2) |
| `--workers N` | requisições paralelas (padrão: 6) |
| `--quiet` | não mostra o resumo de variantes ignoradas |
| `--version` | mostra a versão |

## Sobre "sem logo e marca d'água"

É importante separar três coisas:

1. **Overlay da interface do YouTube** (play, logo do player, título, duração):
   não existe nos arquivos JPEG. A CLI baixa a imagem original, então ela nunca
   vem com esses elementos — diferente de um print da página.
2. **Logo/texto que o criador colocou na própria arte** (ex.: "4K", nome do canal):
   está gravado nos pixels da thumbnail oficial. Nenhum endpoint do YouTube
   entrega uma versão "limpa" disso. A alternativa é usar `--frames`, que pega
   frames gerados automaticamente do vídeo (normalmente sem a arte do criador),
   ou remover a região com `--delogo`.
3. **Marca d'água dentro do vídeo**: pode aparecer tanto na thumb oficial quanto
   nos frames automáticos. Nesse caso, use `--delogo` com as coordenadas da região.

### Removendo um logo com `--delogo`

O filtro `delogo` do ffmpeg interpola os pixels ao redor da caixa indicada. Ele
funciona bem para logos pequenos em cantos, mas **não é mágica**: se a região for
grande ou estiver sobre um detalhe importante, o resultado fica borrado.

Para descobrir as coordenadas, abra a imagem em um editor (GIMP, Krita etc.) e
veja a posição do logo. Ou use o atalho de canto:

```bash
./yt_thumb.py ID --delogo-corner br --delogo-size 20%x12%
```

Cantos: `tl` (superior esquerdo), `tr` (superior direito), `bl` (inferior
esquerdo), `br` (inferior direito).

## Versão web

Abra o `index.html` no navegador. Ela monta as URLs de thumbnail diretamente e
serve para uma consulta rápida, sem instalar nada.

Limitações conhecidas da versão web:

- não verifica se a variante existe (`maxresdefault.jpg` pode retornar 404);
- não remove as barras pretas de `sddefault`/`hqdefault`;
- o seletor de tempo gera URLs inválidas (ex.: `mqdefault5.jpg`) e acaba voltando
  para a thumbnail padrão;
- o botão "Download PNG" baixa o JPEG com extensão `.png`.

Para esses casos, use a CLI.

## Estrutura

```
yt-thumb-extractor/
├── index.html    # interface web
├── script.js     # lógica da interface web
├── style.css     # estilos da interface web
├── yt_thumb.py   # CLI (recomendada)
├── README.md
└── thumbs/       # saída padrão de exemplo (ignorada pelo git)
```

## Direitos

As thumbnails pertencem aos criadores dos vídeos e ao YouTube. Use de acordo com
os direitos autorais e os Termos de Serviço.
