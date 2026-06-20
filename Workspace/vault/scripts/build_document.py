#!/usr/bin/env python3
"""
build_document.py - Professional Document Builder (v3).
Convert markdown to PDF with rich formatting, inline markdown, and auto-rendered mermaid diagrams.

Changelog v3:
  - Paragraph spacing: added gap between paragraphs (Word-like)
  - Bullet indent: proper right-shift for bullet text (including wrap)
  - Table cell height: extra padding to prevent text overlapping border

Features:
  - Inline bold, italic, code, links in paragraphs
  - Color-coded headings (H1=blue, H2=dark, H3=accent)
  - Nested bullets with indent
  - Styled blockquotes with left border
  - Table with accent header, alternating rows, full borders
  - Checkbox items ([x] / [ ])
  - Code blocks with background
  - Auto mermaid diagram rendering

Usage:
    python vault/scripts/build_document.py <input.md> [output.pdf] [image_dir]
"""

import re
import sys
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from fpdf import FPDF

# ── Color Palette ──────────────────────────────────────────────────────────────

COLORS = {
    "title":      (30, 40, 55),
    "h1":         (25, 70, 140),
    "h2":         (40, 40, 40),
    "h3":         (60, 90, 130),
    "body":       (50, 50, 50),
    "muted":      (120, 120, 120),
    "link":       (30, 100, 180),
    "code_fg":    (180, 50, 40),
    "code_bg":    (240, 240, 240),
    "quote_bar":  (25, 70, 140),
    "quote_bg":   (242, 246, 252),
    "tbl_header": (30, 55, 95),
    "tbl_header2":(40, 70, 120),
    "tbl_row_a":  (255, 255, 255),
    "tbl_row_b":  (242, 245, 250),
    "tbl_border": (200, 210, 225),
    "code_bg2":   (245, 247, 250),
    "accent":     (25, 70, 140),
    "separator":  (200, 210, 225),
}

PAGE_W = 210
PAGE_H = 297
PAGE_ML = 28  # left margin (extra for binding)
PAGE_MR = 22  # right margin
PAGE_MT = 28  # top margin
PAGE_MB = 25  # bottom margin
CONTENT_W = PAGE_W - PAGE_ML - PAGE_MR  # 160mm

# ── Text Processing ────────────────────────────────────────────────────────────

def clean_md_inline(text):
    """Strip markdown bold/italic/link syntax for plain rendering."""
    text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
    text = re.sub(r'\*(.*?)\*', r'\1', text)
    text = re.sub(r'`(.*?)`', r'\1', text)
    text = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', text)
    return text.strip()

def sanitize(text):
    """Replace non-latin-1 characters safely."""
    replacements = {
        '\u2014': '--', '\u2013': '-', '\u201c': '"', '\u201d': '"',
        '\u2018': "'", '\u2019': "'", '\u2022': '-', '\u00b7': '-',
        '\u00d7': 'x', '\u2248': '~', '\u2265': '>=', '\u2264': '<=',
        '\u221e': 'inf', '\u2026': '...', '\u2192': '->', '\u2190': '<-',
    }
    for ch, repl in replacements.items():
        text = text.replace(ch, repl)
    result = []
    for c in text:
        try:
            c.encode('latin-1')
            result.append(c)
        except UnicodeEncodeError:
            result.append('?')
    return ''.join(result)

# ── PDF Class ──────────────────────────────────────────────────────────────────

class MarkdownPDF(FPDF):
    def __init__(self, header_text="", image_dir=None):
        super().__init__()
        self.set_margins(PAGE_ML, PAGE_MT, PAGE_MR)
        self.set_auto_page_break(auto=True, margin=PAGE_MB + 10)
        self.header_text = header_text
        self.image_dir = image_dir or ""

    # ── Page Header / Footer ───────────────────────────────────────────────

    def header(self):
        if self.page_no() > 1:
            self.set_font("Helvetica", "I", 7)
            self.set_text_color(*COLORS["muted"])
            self.cell(0, 5, sanitize(self.header_text), align="C")
            self.ln(6)
            self.set_draw_color(*COLORS["tbl_border"])
            self.set_line_width(0.2)
            self.line(PAGE_ML, self.get_y(), PAGE_W - PAGE_MR, self.get_y())
            self.ln(5)

    def footer(self):
        self.set_y(-PAGE_MB + 5)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(*COLORS["muted"])
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")

    # ── Title Page ─────────────────────────────────────────────────────────

    def add_title(self, title, meta):
        self.ln(55)
        self.set_font("Helvetica", "B", 26)
        self.set_text_color(*COLORS["title"])
        self.multi_cell(0, 14, sanitize(title), align="C")
        self.ln(10)
        self.set_draw_color(*COLORS["accent"])
        self.set_line_width(1.2)
        cx = PAGE_W / 2
        self.line(cx - 30, self.get_y(), cx + 30, self.get_y())
        self.ln(12)
        if meta:
            self.set_font("Helvetica", "", 11)
            self.set_text_color(*COLORS["muted"])
            self.multi_cell(0, 7, sanitize(meta), align="C")
            self.ln(8)
        self.ln(25)

    # ── Headings (Color-Coded) ─────────────────────────────────────────────

    def add_h1(self, text):
        if self.get_y() > 50:
            self.ln(6)
        self.set_font("Helvetica", "B", 17)
        self.set_text_color(*COLORS["h1"])
        self.multi_cell(0, 10, sanitize(text))
        self.set_draw_color(*COLORS["h1"])
        self.set_line_width(0.6)
        self.line(PAGE_ML, self.get_y(), PAGE_ML + 50, self.get_y())
        self.ln(9)

    def add_h2(self, text):
        self.ln(5)
        self.set_font("Helvetica", "B", 13)
        self.set_text_color(*COLORS["h2"])
        self.multi_cell(0, 8, sanitize(text))
        self.ln(5)

    def add_h3(self, text):
        self.ln(4)
        self.set_font("Helvetica", "B", 11)
        self.set_text_color(*COLORS["h3"])
        self.multi_cell(0, 7, sanitize(text))
        self.ln(4)

    # ── Inline Markdown Rendering ──────────────────────────────────────────

    def write_inline(self, text, base_font="Helvetica", base_style="", base_size=10):
        """Parse and render inline markdown: **bold**, *italic*, `code`, [link](url)."""
        pattern = re.compile(
            r'(\*\*(.+?)\*\*'
            r'|\*(.+?)\*'
            r'|`(.+?)`'
            r'|\[(.+?)\]\(.+?\))'
        )
        last_end = 0
        for m in pattern.finditer(text):
            before = text[last_end:m.start()]
            if before:
                self.set_font(base_font, base_style, base_size)
                self.set_text_color(*COLORS["body"])
                self.write(7, sanitize(before))
            if m.group(2):
                self.set_font(base_font, "B", base_size)
                self.set_text_color(*COLORS["body"])
                self.write(7, sanitize(m.group(2)))
            elif m.group(3):
                self.set_font(base_font, "I", base_size)
                self.set_text_color(*COLORS["body"])
                self.write(7, sanitize(m.group(3)))
            elif m.group(4):
                self.set_font("Courier", "", base_size - 1)
                self.set_text_color(*COLORS["code_fg"])
                self.write(7, sanitize(m.group(4)))
            elif m.group(5):
                self.set_font(base_font, "", base_size)
                self.set_text_color(*COLORS["link"])
                self.write(7, sanitize(m.group(5)))
            last_end = m.end()
        remaining = text[last_end:]
        if remaining:
            self.set_font(base_font, base_style, base_size)
            self.set_text_color(*COLORS["body"])
            self.write(7, sanitize(remaining))
        self.set_font(base_font, "", base_size)
        self.set_text_color(*COLORS["body"])

    # ── Paragraph ──────────────────────────────────────────────────────────

    def add_paragraph(self, text):
        """Render paragraph with spacing after (Word-like gap between paragraphs)."""
        self.set_font("Helvetica", "", 10)
        self.set_text_color(*COLORS["body"])
        self.write_inline(text)
        self.ln(4)
        # extra gap after paragraph (Word-like spacing)
        self.ln(4)

    # ── Bullet (with proper indent + text wrap) ───────────────────────────

    BULLET_INDENT = 8  # mm per indent level
    BULLET_SYMBOL_W = 6  # mm reserved for symbol + gap

    def add_bullet(self, text, indent=0):
        """Render a bullet with proper right-shift and word wrap at indent."""
        indent_level = min(indent, 2)
        x_start = PAGE_ML + indent_level * self.BULLET_INDENT
        symbols = ["-", "o", "~"]
        symbol = symbols[indent_level]

        old_l_margin = self.l_margin
        old_r_margin = self.r_margin
        self.set_font("Helvetica", "B", 9)
        self.set_text_color(*COLORS["accent"])
        self.set_x(x_start)
        self.write(5, sanitize(symbol + "  "))

        # Shift left margin so multi_cell wraps at indent position
        new_l_margin = x_start + self.BULLET_SYMBOL_W
        self.set_margins(new_l_margin, self.t_margin, old_r_margin)
        self.set_font("Helvetica", "", 10)
        self.set_text_color(*COLORS["body"])
        self.multi_cell(0, 5.5, sanitize(clean_md_inline(text)))

        self.set_margins(old_l_margin, self.t_margin, old_r_margin)
        self.ln(2)

    def add_bold_bullet(self, bold_part, normal_part, indent=0):
        indent_level = min(indent, 2)
        x_start = PAGE_ML + indent_level * self.BULLET_INDENT
        symbols = ["-", "o", "~"]
        symbol = symbols[indent_level]

        old_l_margin = self.l_margin
        old_r_margin = self.r_margin
        self.set_font("Helvetica", "B", 9)
        self.set_text_color(*COLORS["accent"])
        self.set_x(x_start)
        self.write(5, sanitize(symbol + "  "))

        new_l_margin = x_start + self.BULLET_SYMBOL_W
        self.set_margins(new_l_margin, self.t_margin, old_r_margin)
        self.set_text_color(*COLORS["body"])
        # Render bold_part in BOLD, normal_part in NORMAL (via write for inline mixing)
        self.set_font("Helvetica", "B", 10)
        self.write(5.5, sanitize(bold_part))
        self.set_font("Helvetica", "", 10)
        self.write(5.5, sanitize(" " + clean_md_inline(normal_part)))
        self.ln(5.5)

        self.set_margins(old_l_margin, self.t_margin, old_r_margin)
        self.ln(2)

    def add_numbered(self, number, text, indent=0):
        indent_level = min(indent, 2)
        x_start = PAGE_ML + indent_level * self.BULLET_INDENT

        old_l_margin = self.l_margin
        old_r_margin = self.r_margin
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(*COLORS["accent"])
        self.set_x(x_start)
        self.write(8, sanitize(str(number) + "."))

        new_l_margin = x_start + 10
        self.set_margins(new_l_margin, self.t_margin, old_r_margin)
        self.set_font("Helvetica", "", 10)
        self.set_text_color(*COLORS["body"])
        self.multi_cell(0, 5.5, sanitize(clean_md_inline(text)))

        self.set_margins(old_l_margin, self.t_margin, old_r_margin)
        self.ln(2)

    def add_checkbox(self, checked, text):
        mark = "[x]" if checked else "[ ]"
        color = COLORS["accent"] if checked else COLORS["muted"]

        old_l_margin = self.l_margin
        old_r_margin = self.r_margin
        self.set_font("Helvetica", "B", 11)
        self.set_text_color(*color)
        self.set_x(PAGE_ML + 2)
        self.write(6, sanitize(mark + "  "))

        new_l_margin = PAGE_ML + 12
        self.set_margins(new_l_margin, self.t_margin, old_r_margin)
        self.set_font("Helvetica", "", 10)
        self.set_text_color(*COLORS["body"])
        self.multi_cell(0, 5.5, sanitize(clean_md_inline(text)))

        self.set_margins(old_l_margin, self.t_margin, old_r_margin)
        self.ln(2)

    # ── Blockquote ────────────────────────────────────────────────────────

    def add_blockquote(self, text):
        y_start = self.get_y()
        self.set_draw_color(*COLORS["quote_bar"])
        self.set_line_width(1.5)
        self.line(PAGE_ML + 2, y_start, PAGE_ML + 2, y_start + 8)
        self.set_fill_color(*COLORS["quote_bg"])
        self.set_x(PAGE_ML + 8)
        self.set_font("Helvetica", "I", 10)
        self.set_text_color(*COLORS["muted"])
        self.multi_cell(CONTENT_W - 10, 6, sanitize(text), fill=True)
        self.set_text_color(*COLORS["body"])
        self.ln(4)

    # ── Image ─────────────────────────────────────────────────────────────

    def add_image(self, img_path, w=170):
        if not os.path.exists(img_path):
            self.add_paragraph(f"[Image not found: {img_path}]")
            return
        from PIL import Image as PILImage
        with PILImage.open(img_path) as im:
            iw, ih = im.size
        aspect = ih / iw
        display_w = min(w, CONTENT_W)
        display_h = display_w * aspect
        if self.get_y() + display_h > 297 - 30:
            self.add_page()
        x = (PAGE_W - display_w) / 2
        self.image(img_path, x=x, w=display_w)
        self.ln(8)

    # ── Table (Enhanced v3) ───────────────────────────────────────────────

    def add_table(self, headers, rows):
        self.ln(4)
        self.set_x(PAGE_ML)
        n_cols = len(headers)
        col_width = CONTENT_W / n_cols
        line_h = 4.5
        pad = 3  # increased padding for table cells

        def calc_row_height(row_data, font, style, size):
            self.set_font(font, style, size)
            max_lines = 1
            for cell_text in row_data:
                clean = sanitize(clean_md_inline(cell_text.strip()))
                sw = self.get_string_width(clean)
                n_lines = max(1, int(sw / (col_width - 2 * pad)) + 1)
                max_lines = max(max_lines, n_lines)
            return max_lines * line_h + 2 * pad + 2  # extra 2mm buffer

        header_h = calc_row_height(headers, 'Helvetica', 'B', 8)
        total_h = header_h
        for row in rows:
            total_h += calc_row_height(row, 'Helvetica', '', 8)
        if self.get_y() + total_h + 10 > 297 - PAGE_MB:
            self.add_page()

        x_start = self.get_x()
        y_start = self.get_y()

        # Header
        self.set_font('Helvetica', 'B', 8)
        self.set_fill_color(*COLORS['tbl_header'])
        self.set_text_color(255, 255, 255)
        self.set_draw_color(*COLORS['tbl_border'])
        for i, h in enumerate(headers):
            h_clean = sanitize(clean_md_inline(h.strip()))
            x = x_start + i * col_width
            self.rect(x, y_start, col_width, header_h, 'DF')
            self.set_xy(x + pad, y_start + pad)
            self.multi_cell(col_width - 2 * pad, line_h, h_clean, align='C')
        self.set_y(y_start + header_h)

        # Data rows
        for row_idx, row in enumerate(rows):
            row_h = calc_row_height(row, 'Helvetica', '', 8)
            if self.get_y() + row_h > 297 - PAGE_MB:
                self.add_page()
            if row_idx % 2 == 0:
                self.set_fill_color(*COLORS['tbl_row_a'])
            else:
                self.set_fill_color(*COLORS['tbl_row_b'])
            self.set_text_color(*COLORS['body'])
            self.set_draw_color(*COLORS['tbl_border'])
            self.set_font('Helvetica', '', 8)
            y_row = self.get_y()
            for i, cell_text in enumerate(row):
                cell_clean = sanitize(clean_md_inline(cell_text.strip()))
                x = x_start + i * col_width
                self.rect(x, y_row, col_width, row_h, 'DF')
                self.set_xy(x + pad, y_row + pad)
                self.multi_cell(col_width - 2 * pad, line_h, cell_clean, align='L')
            self.set_y(y_row + row_h)
        self.ln(6)

    # ── Code Block ────────────────────────────────────────────────────────

    def add_code_block(self, text):
        self.set_fill_color(*COLORS["code_bg2"])
        self.set_draw_color(*COLORS["tbl_border"])
        y0 = self.get_y()
        self.rect(PAGE_ML, y0, CONTENT_W, 5, style="DF")
        self.set_y(y0 + 3)
        self.set_font("Courier", "", 8)
        self.set_text_color(60, 60, 60)
        self.set_x(PAGE_ML + 4)
        self.multi_cell(CONTENT_W - 8, 5, sanitize(text), fill=False)
        self.set_y(self.get_y() + 2)
        self.ln(4)

    # ── Separator ─────────────────────────────────────────────────────────

    def add_separator(self):
        self.ln(4)
        y = self.get_y()
        self.set_draw_color(*COLORS["separator"])
        self.set_line_width(0.4)
        self.line(PAGE_ML, y, PAGE_W - PAGE_ML, y)
        self.ln(6)

# ── Table Parsing ─────────────────────────────────────────────────────────────

def parse_md_table(lines, start_idx):
    headers = [c.strip() for c in lines[start_idx].strip('|').split('|')]
    rows = []
    i = start_idx + 2
    while i < len(lines) and lines[i].strip().startswith('|'):
        row = [c.strip() for c in lines[i].strip('|').split('|')]
        rows.append(row)
        i += 1
    return headers, rows, i

# ── Mermaid Rendering ─────────────────────────────────────────────────────────

_mermaid_counter = 0

def _render_mermaid_block(content, image_dir):
    """Render mermaid block to PNG using mmdc CLI (Mermaid CLI v11+)."""
    global _mermaid_counter
    _mermaid_counter += 1
    content_stripped = content.strip()
    if not content_stripped:
        return None

    # Determine diagram type prefix for filename
    first_line = content_stripped.split('\n')[0].strip()
    if first_line.startswith('classDiagram'):
        prefix = 'cd'
    elif first_line.startswith('gantt'):
        prefix = 'gt'
    else:
        prefix = 'fc'

    out = os.path.join(image_dir, f'_mermaid_{prefix}_{_mermaid_counter}.png')
    tmp_mmd = os.path.join(image_dir, f'_tmp_mmd_{_mermaid_counter}.mmd')

    try:
        # Inject thick line config for better visibility (especially after Telegram compression)
        init_config = "%%{init: {'theme': 'neutral', 'themeVariables': {'lineColor': '#333333', 'lineWidth': '3px', 'fontSize': '14px'}}}%%"
        # Prepend config if not already present
        if '%%{init:' not in content_stripped:
            content_stripped = init_config + '\n' + content_stripped

        # Write mermaid content to temp .mmd file
        with open(tmp_mmd, 'w', encoding='utf-8') as f:
            f.write(content_stripped)

        # Run mmdc to render PNG (use .cmd on Windows)
        import subprocess, shutil
        mmdc_cmd = shutil.which('mmdc.cmd') or shutil.which('mmdc') or 'mmdc.cmd'
        result = subprocess.run(
            [mmdc_cmd, '-i', tmp_mmd, '-o', out, '-b', 'white', '-s', '3', '-q'],
            capture_output=True, text=True, timeout=60
        )

        # Cleanup temp .mmd file
        try:
            os.remove(tmp_mmd)
        except OSError:
            pass

        if result.returncode == 0 and os.path.exists(out):
            return out
        else:
            print(f"[WARN] mmdc render failed (rc={result.returncode}): {result.stderr.strip()}")
            return None

    except FileNotFoundError:
        print("[ERROR] mmdc not found. Install via: npm install -g @mermaid-js/mermaid-cli")
        return None
    except subprocess.TimeoutExpired:
        print("[WARN] mmdc render timed out")
        return None
    except Exception as e:
        print(f"[WARN] Mermaid render failed: {e}")
        # Cleanup on error
        try:
            os.remove(tmp_mmd)
        except OSError:
            pass
        return None

# ── Section Image Map ─────────────────────────────────────────────────────────

IMAGE_MAP = {
    "user flow": "user-flow.png",
    "user flow (visual)": "user-flow.png",
    "timeline": "timeline.png",
    "timeline & milestones": "timeline.png",
    "timeline & milestones (visual)": "timeline.png",
    "milestones": "timeline.png",
}

# ── Markdown Parser ───────────────────────────────────────────────────────────

def convert_md_to_pdf(md_path, pdf_path, image_dir=None):
    if image_dir is None:
        image_dir = os.path.dirname(pdf_path) or "."

    with open(md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')

    header_text = ""
    for line in lines:
        if line.strip().startswith('# '):
            header_text = line.strip()[2:]
            break

    pdf = MarkdownPDF(header_text=header_text, image_dir=image_dir)
    pdf.alias_nb_pages()
    pdf.add_page()

    i = 0
    title_set = False

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        if stripped in ('---', '***'):
            pdf.add_separator()
            i += 1
            continue

        if stripped.startswith('```'):
            code_lines = []
            lang = stripped[3:].strip()
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code_lines.append(lines[i])
                i += 1
            if i < len(lines):
                i += 1
            block_content = '\n'.join(code_lines)
            if lang == 'mermaid' and block_content.strip():
                rendered_img = _render_mermaid_block(block_content, image_dir)
                if rendered_img:
                    pdf.add_image(rendered_img, w=160)
                else:
                    pdf.add_code_block(block_content)
            else:
                pdf.add_code_block(block_content)
            continue

        if stripped.startswith('> Version:') or stripped.startswith('>'):
            i += 1
            continue

        if stripped.startswith('# ') and not title_set:
            title = stripped[2:]
            meta_lines = []
            j = i + 1
            while j < len(lines):
                ml = lines[j].strip()
                if ml.startswith('>'):
                    meta_lines.append(ml.lstrip('> ').strip())
                    j += 1
                elif not ml:
                    j += 1
                else:
                    break
            meta = ' | '.join(meta_lines)
            pdf.add_title(title, meta)
            title_set = True
            i = j
            pdf.add_page()
            continue

        if stripped.startswith('# ') and not stripped.startswith('##'):
            if title_set:
                pdf.add_h1(stripped[2:])
            i += 1
            continue

        if stripped.startswith('## '):
            section_name = stripped[3:].strip()
            pdf.add_h2(section_name)
            section_lower = section_name.lower()
            for key, img_file in IMAGE_MAP.items():
                if key in section_lower:
                    img_path = os.path.join(image_dir, img_file)
                    if os.path.exists(img_path):
                        pdf.add_image(img_path, w=160)
                    break
            i += 1
            continue

        if stripped.startswith('### '):
            pdf.add_h3(stripped[4:])
            i += 1
            continue

        if stripped.startswith('> '):
            pdf.add_blockquote(stripped[2:])
            i += 1
            continue

        if stripped.startswith('|') and i + 1 < len(lines) and '---' in lines[i + 1]:
            headers, rows, next_i = parse_md_table(lines, i)
            pdf.add_table(headers, rows)
            i = next_i
            continue

        num_match = re.match(r'^(\d+)\s+(.*)', stripped)
        if num_match:
            pdf.add_numbered(num_match.group(1), num_match.group(2))
            i += 1
            continue

        checkbox = re.match(r'^[-*]\s+\[([ x])\]\s+(.*)', stripped)
        if checkbox:
            pdf.add_checkbox(checkbox.group(1) == 'x', checkbox.group(2))
            i += 1
            continue

        bold_bullet = re.match(r'^[-*]\s+\*\*(.*?)\*\*\s*[:\s]*(.*)', stripped)
        if bold_bullet:
            bold_text = bold_bullet.group(1).rstrip(':')
            pdf.add_bold_bullet(bold_text + ":", bold_bullet.group(2))
            i += 1
            continue

        bullet_match = re.match(r'^(\s*)[-*]\s+(.*)', line)
        if bullet_match:
            leading = bullet_match.group(1)
            indent = min(len(leading) // 2, 2)
            pdf.add_bullet(bullet_match.group(2), indent)
            i += 1
            continue

        pdf.add_paragraph(stripped)
        i += 1

    pdf.output(pdf_path)
    print(f"PDF generated: {pdf_path}")

def build(md_path, pdf_path=None, image_dir=None):
    workspace = os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))
    default_media = os.path.join(workspace, 'vault', '03_creating', 'media')
    default_assets = os.path.join(workspace, 'vault', '03_creating', 'assets')
    os.makedirs(default_media, exist_ok=True)
    os.makedirs(default_assets, exist_ok=True)

    if pdf_path is None:
        basename = os.path.splitext(os.path.basename(md_path))[0]
        pdf_path = os.path.join(default_assets, f'{basename}.pdf')
    if image_dir is None:
        image_dir = default_media

    convert_md_to_pdf(md_path, pdf_path, image_dir)
    return pdf_path

if __name__ == "__main__":
    if len(sys.argv) >= 2:
        md_file = sys.argv[1]
        pdf_file = sys.argv[2] if len(sys.argv) > 2 else None
        img_dir = sys.argv[3] if len(sys.argv) > 3 else None
        result = build(md_file, pdf_file, img_dir)
        print(f"Done: {result}")
    else:
        print("Usage: python build_document.py <input.md> [output.pdf] [image_dir]")
        sys.exit(1)