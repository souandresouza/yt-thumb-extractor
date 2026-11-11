#!/usr/bin/env python3
"""
yt_thumb.py - extrai thumbnails do YouTube em alta resolução.

Diferente de uma página que apenas monta URLs, este script:
  * valida cada variante (HTTP 404, placeholder 120x90, dimensões reais);
  * escolhe a maior imagem disponível;
  * remove barras pretas (letterbox/pillarbox) automaticamente;
  * pode remover uma região fixa de logo/marca d'água com o filtro delogo do ffmpeg;
  * lista/salva todas as variantes disponíveis, inclusive frames automáticos.

Sem dependências Python externas. ImageMagick e ffmpeg são opcionais.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

__version__ = "1.0.0"

URL_TEMPLATE = "https://i.ytimg.com/vi/{video_id}/{variant}.jpg"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

CREATOR = "creator"
AUTO = "auto"

# Thumbnails enviadas pelo criador (a arte oficial do vídeo).
CREATOR_VARIANTS = [
    "maxresdefault",  # 1280x720 (quando existe)
    "hq720",          # 1280x720 (costuma ser idêntica à maxresdefault)
    "sddefault",      # 640x480, normalmente com barras
    "hqdefault",      # 480x360, normalmente com barras
    "mqdefault",      # 320x180
    "default",        # 120x90 (placeholder/último recurso)
]

# Frames gerados automaticamente pelo YouTube a partir do vídeo.
AUTO_VARIANTS = [
    "maxres1", "maxres2", "maxres3",
    "oar2", "oar3",
    "sd1", "sd2", "sd3",
    "hq1", "hq2", "hq3",
    "mq1", "mq2", "mq3",
    "0", "1", "2", "3",
]

JPEG_MAGIC = b"\xff\xd8\xff"
DARK_LEVEL = 40          # canal máximo considerado "preto" ao detectar barras
MIN_SIDE = 16            # lado mínimo aceitável para crop
DARK_AREA_MIN = 0.40     # fração mínima da imagem preservada no crop


class ThumbError(RuntimeError):
    pass


@dataclass
class Variant:
    name: str
    kind: str
    order: int
    video_id: str
    url: str = ""
    data: Optional[bytes] = None
    width: int = 0
    height: int = 0
    sha256: str = ""
    error: Optional[str] = None
    duplicate_of: Optional[str] = None
    placeholder: bool = False
    trimmed: bool = False
    delogo: bool = False
    path: Optional[str] = None

    @property
    def pixels(self) -> int:
        return self.width * self.height

    @property
    def label(self) -> str:
        return f"{self.width}x{self.height}"

    def to_dict(self) -> Dict[str, object]:
        return {
            "variant": self.name,
            "kind": self.kind,
            "url": self.url,
            "width": self.width,
            "height": self.height,
            "bytes": len(self.data) if self.data else 0,
            "sha256": self.sha256,
            "duplicate_of": self.duplicate_of,
            "placeholder": self.placeholder,
            "trimmed": self.trimmed,
            "delogo": self.delogo,
            "path": self.path,
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# Entrada / IDs
# ---------------------------------------------------------------------------

_RAW_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_URL_ID_RE = re.compile(
    r"(?:youtu\.be/|youtube(?:-nocookie)?\.com/(?:watch\?(?:[^#]*&)?v=|shorts/|live/|embed/|v/))"
    r"([A-Za-z0-9_-]{11})"
)


def extract_video_id(text: str) -> Optional[str]:
    """Aceita URL completa, link curto, shorts, live, embed ou o ID puro."""
    text = text.strip()
    if not text:
        return None
    if _RAW_ID_RE.match(text):
        return text

    if "://" not in text and not text.startswith(("www.", "youtu.")):
        text = "https://" + text

    parsed = urlparse(text)
    host = (parsed.netloc or "").lower()

    if host.endswith("youtu.be"):
        candidate = parsed.path.strip("/").split("/")[0]
        return candidate if _RAW_ID_RE.match(candidate) else None

    if "youtube.com" in host or "youtube-nocookie.com" in host:
        if parsed.path in ("/watch", "/watch_popup"):
            candidate = (parse_qs(parsed.query).get("v") or [""])[0]
            return candidate if _RAW_ID_RE.match(candidate) else None
        for prefix in ("/shorts/", "/live/", "/embed/", "/v/"):
            if parsed.path.startswith(prefix):
                candidate = parsed.path[len(prefix):].split("/")[0]
                return candidate if _RAW_ID_RE.match(candidate) else None

    match = _URL_ID_RE.search(text)
    return match.group(1) if match else None


# ---------------------------------------------------------------------------
# HTTP / imagem
# ---------------------------------------------------------------------------

def _http_get(url: str, timeout: float, retries: int) -> bytes:
    last_error: Optional[BaseException] = None
    for attempt in range(retries + 1):
        try:
            request = Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Referer": "https://www.youtube.com/",
                },
            )
            with urlopen(request, timeout=timeout) as response:
                if response.status != 200:
                    raise ThumbError(f"HTTP {response.status}")
                return response.read()
        except HTTPError as exc:
            if exc.code == 404:
                raise
            last_error = exc
        except (URLError, TimeoutError, OSError, ThumbError) as exc:
            last_error = exc
        if attempt < retries:
            time.sleep(0.4 * (attempt + 1))
    raise ThumbError(str(last_error) if last_error else "falha de rede")


def jpeg_size(data: bytes) -> Optional[Tuple[int, int]]:
    """Lê largura/altura de um JPEG sem bibliotecas externas."""
    if not data.startswith(JPEG_MAGIC):
        return None
    index = 2
    length = len(data)
    sof_markers = {
        0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
        0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
    }
    while index < length - 1:
        if data[index] != 0xFF:
            index += 1
            continue
        while index < length and data[index] == 0xFF:
            index += 1
        if index >= length:
            break
        marker = data[index]
        index += 1
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if marker == 0xD9:
            break
        if index + 1 >= length:
            break
        segment_length = struct.unpack(">H", data[index:index + 2])[0]
        if segment_length < 2:
            return None
        if marker in sof_markers:
            if index + 7 > length:
                return None
            height, width = struct.unpack(">HH", data[index + 3:index + 7])
            return (width, height) if width and height else None
        index += segment_length
    return None


def probe_variant(
    variant: str,
    kind: str,
    order: int,
    video_id: str,
    timeout: float,
    retries: int,
) -> Variant:
    item = Variant(
        name=variant,
        kind=kind,
        order=order,
        video_id=video_id,
        url=URL_TEMPLATE.format(video_id=video_id, variant=variant),
    )
    try:
        data = _http_get(item.url, timeout=timeout, retries=retries)
    except HTTPError as exc:
        item.error = "404 (não existe)" if exc.code == 404 else f"HTTP {exc.code}"
        return item
    except ThumbError as exc:
        item.error = str(exc)
        return item

    size = jpeg_size(data)
    if not size:
        item.error = "resposta não é um JPEG válido"
        return item

    item.data = data
    item.width, item.height = size
    item.sha256 = hashlib.sha256(data).hexdigest()
    item.placeholder = item.width <= 120 and item.height <= 90
    return item


def probe_all(
    video_id: str,
    include_frames: bool,
    timeout: float,
    retries: int,
    workers: int,
) -> List[Variant]:
    variants: List[Variant] = []
    order = 0
    for name in CREATOR_VARIANTS:
        variants.append(Variant(name=name, kind=CREATOR, order=order, video_id=video_id))
        order += 1
    if include_frames:
        for name in AUTO_VARIANTS:
            variants.append(Variant(name=name, kind=AUTO, order=order, video_id=video_id))
            order += 1

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(workers, len(variants)))) as pool:
        futures = [
            pool.submit(
                probe_variant, item.name, item.kind, item.order,
                video_id, timeout, retries,
            )
            for item in variants
        ]
        variants = sorted(
            (future.result() for future in concurrent.futures.as_completed(futures)),
            key=lambda entry: entry.order,
        )

    # Deduplica pelo conteúdo (ex.: maxresdefault e hq720 costumam ser iguais).
    seen: Dict[str, Variant] = {}
    for item in sorted(variants, key=lambda entry: entry.order):
        if not item.data:
            continue
        previous = seen.get(item.sha256)
        if previous is not None:
            item.duplicate_of = previous.name
        else:
            seen[item.sha256] = item

    return variants


def choose_best(variants: List[Variant]) -> Optional[Variant]:
    usable = [
        item for item in variants
        if item.data and not item.duplicate_of and not item.placeholder
    ]
    if not usable:
        usable = [item for item in variants if item.data and not item.duplicate_of]
    if not usable:
        return None
    usable.sort(
        key=lambda item: (
            -item.pixels,
            item.kind != CREATOR,  # em empate, prefere a thumb do criador
            item.order,
        )
    )
    return usable[0]


# ---------------------------------------------------------------------------
# Pós-processamento (ImageMagick / ffmpeg)
# ---------------------------------------------------------------------------

def find_magick() -> Optional[str]:
    return shutil.which("magick") or shutil.which("convert")


def find_ffmpeg() -> Optional[str]:
    return shutil.which("ffmpeg")


def _raw_rgb(magick: str, path: Path, width: int, height: int) -> Optional[bytes]:
    try:
        result = subprocess.run(
            [magick, str(path), "-depth", "8", "rgb:-"],
            capture_output=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0 or len(result.stdout) != width * height * 3:
        return None
    return result.stdout


def _is_dark(raw: bytes, offset: int) -> bool:
    return (
        raw[offset] <= DARK_LEVEL
        and raw[offset + 1] <= DARK_LEVEL
        and raw[offset + 2] <= DARK_LEVEL
    )


def detect_bar_box(
    raw: bytes, width: int, height: int
) -> Optional[Tuple[int, int, int, int]]:
    """Detecta barras pretas simétricas e devolve (x, y, w, h) para cortar."""
    stride = width * 3
    total_bytes = width * height * 3

    def row_is_dark(y: int) -> bool:
        base = y * stride
        return all(
            _is_dark(raw, base + x * 3)
            for x in range(0, width)
        )

    def column_is_dark(x: int) -> bool:
        offset = x * 3
        return all(
            _is_dark(raw, offset + y * stride)
            for y in range(0, height)
        )

    top = 0
    while top < height and row_is_dark(top):
        top += 1

    bottom = 0
    while top + bottom < height and row_is_dark(height - 1 - bottom):
        bottom += 1

    left = 0
    while left < width and column_is_dark(left):
        left += 1

    right = 0
    while left + right < width and column_is_dark(width - 1 - right):
        right += 1

    if top + bottom >= height or left + right >= width:
        return None  # imagem toda preta (ou quase), não cortar

    def symmetric(first: int, second: int) -> bool:
        return abs(first - second) <= max(3, int(0.12 * max(first, second)))

    vertical = symmetric(top, bottom)
    horizontal = symmetric(left, right)

    # Ignora bordas de 1-2 px (ruído de JPEG): só vale a pena recortar de verdade.
    min_vertical = max(6, round(0.015 * height))
    min_horizontal = max(6, round(0.015 * width))

    if not vertical or min(top, bottom) < min_vertical:
        top = bottom = 0
    if not horizontal or min(left, right) < min_horizontal:
        left = right = 0

    if top + bottom == 0 and left + right == 0:
        return None
    if top + bottom > 0.45 * height or left + right > 0.45 * width:
        return None

    new_width = width - left - right
    new_height = height - top - bottom
    if new_width < MIN_SIDE or new_height < MIN_SIDE:
        return None
    if (new_width * new_height) / (width * height) < DARK_AREA_MIN:
        return None
    if not 0.25 <= new_width / new_height <= 4.0:
        return None
    return left, top, new_width, new_height


def crop_image(magick: str, path: Path, box: Tuple[int, int, int, int]) -> None:
    x, y, width, height = box
    temp = path.with_name(f".{path.stem}.crop{path.suffix}")
    result = subprocess.run(
        [
            magick, str(path),
            "-crop", f"{width}x{height}+{x}+{y}",
            "+repage", "-strip",
            "-quality", "90", "-sampling-factor", "4:2:0",
            str(temp),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0 or not temp.exists():
        temp.unlink(missing_ok=True)
        raise ThumbError(result.stderr.strip() or "falha ao cortar a imagem")
    os.replace(temp, path)


def parse_size(value: str, width: int, height: int) -> Tuple[int, int]:
    parts = re.split(r"[xX×]", value.strip(), maxsplit=1)
    if len(parts) != 2:
        raise ThumbError("tamanho inválido; use LARGURAxALTURA (ex.: 180x80 ou 20%x12%)")

    def convert(token: str, total: int) -> int:
        token = token.strip()
        try:
            if token.endswith("%"):
                return max(2, round(total * float(token[:-1]) / 100))
            return max(2, int(token))
        except ValueError:
            raise ThumbError(
                "tamanho inválido; use LARGURAxALTURA (ex.: 180x80 ou 20%x12%)"
            )

    return convert(parts[0], width), convert(parts[1], height)


def resolve_delogo_box(args: argparse.Namespace, width: int, height: int) -> Optional[Tuple[int, int, int, int]]:
    if args.delogo:
        match = re.match(
            r"^\s*(\d+)\s*[,:x]\s*(\d+)\s*[,:x]\s*(\d+)\s*[,:x]\s*(\d+)\s*$",
            args.delogo,
        )
        if not match:
            raise ThumbError("--delogo inválido; use X,Y,LARGURA,ALTURA em pixels")
        x, y, box_width, box_height = (int(value) for value in match.groups())
    elif args.delogo_corner:
        box_width, box_height = parse_size(args.delogo_size, width, height)
        margin = max(2, min(width, height) // 100)
        if args.delogo_corner == "tl":
            x, y = margin, margin
        elif args.delogo_corner == "tr":
            x, y = width - box_width - margin, margin
        elif args.delogo_corner == "bl":
            x, y = margin, height - box_height - margin
        else:  # br
            x, y = width - box_width - margin, height - box_height - margin
    else:
        return None

    box_width = min(box_width, width - 4)
    box_height = min(box_height, height - 4)
    if box_width < 2 or box_height < 2:
        raise ThumbError("região de delogo pequena demais para esta imagem")
    x = max(2, min(x, width - box_width - 2))
    y = max(2, min(y, height - box_height - 2))
    return x, y, box_width, box_height


def apply_delogo(ffmpeg: str, path: Path, box: Tuple[int, int, int, int]) -> None:
    x, y, width, height = box
    temp = path.with_name(f".{path.stem}.delogo{path.suffix}")
    result = subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(path),
            "-vf", f"delogo=x={x}:y={y}:w={width}:h={height}",
            "-frames:v", "1", "-q:v", "2",
            str(temp),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0 or not temp.exists():
        temp.unlink(missing_ok=True)
        raise ThumbError(result.stderr.strip() or "falha ao aplicar delogo")
    os.replace(temp, path)


# ---------------------------------------------------------------------------
# Salvamento / relatório
# ---------------------------------------------------------------------------

def save_variant(
    item: Variant,
    output_dir: Path,
    do_trim: bool,
    magick: Optional[str],
    delogo_args: Optional[argparse.Namespace],
    ffmpeg: Optional[str],
) -> Tuple[Path, List[str]]:
    notes: List[str] = []
    output_dir.mkdir(parents=True, exist_ok=True)
    temp = output_dir / f".{item.video_id}-{item.name}.part.jpg"
    temp.write_bytes(item.data or b"")

    try:
        if do_trim and magick:
            raw = _raw_rgb(magick, temp, item.width, item.height)
            if raw:
                box = detect_bar_box(raw, item.width, item.height)
                if box:
                    old = item.label
                    crop_image(magick, temp, box)
                    item.width, item.height = box[2], box[3]
                    item.trimmed = True
                    notes.append(f"barras removidas ({old} -> {item.label})")

        if delogo_args is not None:
            if not ffmpeg:
                raise ThumbError("ffmpeg não encontrado; instale para usar --delogo")
            delogo_box = resolve_delogo_box(delogo_args, item.width, item.height)
            apply_delogo(ffmpeg, temp, delogo_box)
            item.delogo = True
            notes.append(
                "marca d'água removida em "
                f"x={delogo_box[0]}, y={delogo_box[1]}, "
                f"w={delogo_box[2]}, h={delogo_box[3]}"
            )
    except ThumbError:
        temp.unlink(missing_ok=True)
        raise

    suffix = ""
    if item.trimmed:
        suffix += "-trim"
    if item.delogo:
        suffix += "-nologo"
    final = output_dir / f"{item.video_id}-{item.name}-{item.width}x{item.height}{suffix}.jpg"
    os.replace(temp, final)
    item.path = str(final)
    return final, notes


def log(message: str, as_json: bool = False) -> None:
    print(message, file=sys.stderr if as_json else sys.stdout)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="yt_thumb.py",
        description=(
            "Baixa a melhor thumbnail disponível de vídeos do YouTube "
            "usando os arquivos originais (sem overlay da interface)."
        ),
        epilog=(
            "Exemplos:\n"
            "  yt_thumb.py https://youtu.be/dQw4w9WgXcQ\n"
            "  yt_thumb.py dQw4w9WgXcQ -o thumbs --all --frames\n"
            "  yt_thumb.py ID --delogo-corner br --delogo-size 22%x12%\n"
            "  yt_thumb.py ID --delogo 1100,620,160,80\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("targets", nargs="+", metavar="URL|ID", help="URLs/IDs (ou um arquivo .txt com um por linha)")
    parser.add_argument("-o", "--output", default=".", help="diretório de saída (padrão: .)")
    parser.add_argument("--all", action="store_true", help="salvar todas as variantes válidas, não só a melhor")
    parser.add_argument("--frames", action="store_true", help="incluir frames automáticos (1-3, oar2/3) como candidatos")
    parser.add_argument("--no-trim", action="store_true", help="não remover barras pretas automaticamente")
    parser.add_argument("--delogo", metavar="X,Y,W,H", help="remove logo/marca d'água nessa região (pixels, ffmpeg)")
    parser.add_argument("--delogo-corner", choices=["tl", "tr", "bl", "br"], help="atalho: remove logo no canto indicado")
    parser.add_argument("--delogo-size", default="20%x12%", metavar="WxH", help="tamanho do logo para --delogo-corner (padrão: 20%%x12%%)")
    parser.add_argument("--json", action="store_true", help="imprime metadados em JSON no stdout")
    parser.add_argument("--timeout", type=float, default=20.0, help="timeout por requisição em segundos (padrão: 20)")
    parser.add_argument("--retries", type=int, default=2, help="tentativas extras por requisição (padrão: 2)")
    parser.add_argument("--workers", type=int, default=6, help="requisições paralelas (padrão: 6)")
    parser.add_argument("--quiet", action="store_true", help="não mostrar o resumo no terminal")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return parser


def expand_targets(raw_targets: List[str]) -> List[str]:
    expanded: List[str] = []
    for target in raw_targets:
        path = Path(target)
        if path.is_file() and path.suffix.lower() == ".txt":
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    expanded.append(line)
        else:
            expanded.append(target)
    return expanded


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    targets = expand_targets(args.targets)
    output_dir = Path(args.output).expanduser()

    magick = find_magick()
    ffmpeg = find_ffmpeg()
    do_trim = not args.no_trim

    if do_trim and not magick and not args.quiet:
        log("aviso: ImageMagick não encontrado; barras pretas não serão removidas.", args.json)
    if (args.delogo or args.delogo_corner) and not ffmpeg:
        log("erro: --delogo requer ffmpeg instalado.", args.json)
        return 2

    results = []
    successes = 0

    for index, target in enumerate(targets, start=1):
        video_id = extract_video_id(target)
        header = f"[{index}/{len(targets)}] {target}"
        if not video_id:
            log(f"{header}\n  ✗ URL/ID inválido", args.json)
            results.append({"input": target, "error": "URL/ID inválido"})
            continue

        log(f"{header}  (id: {video_id})", args.json)
        variants = probe_all(
            video_id,
            include_frames=args.frames,
            timeout=args.timeout,
            retries=args.retries,
            workers=args.workers,
        )
        valid = [item for item in variants if item.data]
        chosen = choose_best(variants)

        if chosen is None:
            details = "; ".join(
                f"{item.name}: {item.error}" for item in variants if item.error
            )
            log(f"  ✗ nenhuma thumbnail disponível. {details}", args.json)
            results.append({
                "input": target,
                "video_id": video_id,
                "error": "nenhuma thumbnail disponível",
                "variants": [item.to_dict() for item in variants if item.error],
            })
            continue

        if chosen.placeholder and not args.quiet:
            log("  aviso: só existe o placeholder 120x90; qualidade muito baixa", args.json)

        delogo_requested = bool(args.delogo or args.delogo_corner)
        if delogo_requested:
            try:
                resolve_delogo_box(args, chosen.width, chosen.height)
            except ThumbError as exc:
                log(f"  ✗ {exc}", args.json)
                results.append({"input": target, "video_id": video_id, "error": str(exc)})
                continue

        to_save = [chosen]
        if args.all:
            to_save = [
                item for item in variants
                if item.data and not item.duplicate_of and not item.placeholder
            ]
            to_save.sort(key=lambda item: (-item.pixels, item.order))
            if chosen not in to_save:
                to_save.append(chosen)

        report_variants = []
        saved_notes: List[str] = []
        for item in to_save:
            try:
                final, notes = save_variant(
                    item, output_dir, do_trim, magick,
                    args if (delogo_requested and item is chosen) else None,
                    ffmpeg,
                )
            except ThumbError as exc:
                log(f"  ✗ {item.name}: {exc}", args.json)
                report_variants.append({**item.to_dict(), "error": str(exc)})
                continue

            tag = "thumb do criador" if item.kind == CREATOR else "frame automático"
            marker = "✓" if item is chosen else "·"
            log(f"  {marker} {item.name:14} {item.label:9} [{tag}] -> {final}", args.json)
            for note in notes:
                log(f"      {note}", args.json)
                saved_notes.append(note)
            report_variants.append(item.to_dict())

        if any(item.path for item in to_save):
            successes += 1

        if not args.all and not args.quiet:
            ignored = [
                item for item in variants
                if item.error or item.placeholder or item.duplicate_of
            ]
            if ignored:
                def reason(item: Variant) -> str:
                    if item.error:
                        return item.error
                    return "duplicada" if item.duplicate_of else "placeholder"

                summary = ", ".join(
                    f"{item.name} ({reason(item)})" for item in ignored[:6]
                )
                log(f"  ignoradas: {summary}", args.json)

        results.append({
            "input": target,
            "video_id": video_id,
            "chosen": chosen.to_dict(),
            "notes": saved_notes,
            "variants": report_variants if args.all else [item.to_dict() for item in valid],
        })

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))

    return 0 if successes else 1


if __name__ == "__main__":
    sys.exit(main())
