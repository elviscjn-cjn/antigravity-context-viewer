"""Read-only attachment inventory. Outputs counts, never cell contents."""
import sys, json, os, re, zipfile, time, xml.etree.ElementTree as ET
sys.path.insert(0, os.path.join(os.environ.get('LOCALAPPDATA', ''), 'AntigravityContextMeter', 'python-packages'))

MAX_BYTES = 256 * 1024 * 1024
MAX_UNPACKED = 512 * 1024 * 1024
MAX_CHARS = 100_000_000

class Counter:
    def __init__(self):
        self.chars = self.bytes = self.cjk = 0
        self.deadline = time.monotonic() + 45
    def add(self, value):
        text = '' if value is None else str(value)
        self.chars += len(text)
        self.bytes += len(text.encode('utf-8', errors='replace'))
        self.cjk += len(re.findall(r'[\u2e80-\u9fff\uf900-\ufaff]', text))
        if self.chars > MAX_CHARS or time.monotonic() > self.deadline:
            raise ValueError('达到本地扫描资源限制，统计不完整')
    def result(self):
        import math
        mid = (self.chars - self.cjk) / 4 + self.cjk * 1.2
        return dict(chars=self.chars, bytes=self.bytes, low=math.ceil(mid * .7), high=math.ceil(max(mid * 1.6, self.bytes / 2)))

def local(tag):
    return tag.rsplit('}', 1)[-1]

def xlsx_scan(path, counter, result):
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        if sum(i.file_size for i in infos) > MAX_UNPACKED:
            raise ValueError('解压后体积超过 512 MiB，本地扫描未完成')
        names = set(z.namelist())
        strings = []
        if 'xl/sharedStrings.xml' in names:
            with z.open('xl/sharedStrings.xml') as f:
                for event, e in ET.iterparse(f, events=('end',)):
                    if local(e.tag) == 'si':
                        strings.append(''.join(t.text or '' for t in e.iter() if local(t.tag) == 't'))
                        e.clear()
        result.update(sheets=0, hiddenSheets=0, cells=0, formulas=0)
        if 'xl/workbook.xml' in names:
            workbook = ET.fromstring(z.read('xl/workbook.xml'))
            for e in workbook.iter():
                if local(e.tag) == 'sheet':
                    counter.add(e.attrib.get('name', ''))
                    if e.attrib.get('state') in ('hidden', 'veryHidden'):
                        result['hiddenSheets'] += 1
        for name in sorted(names):
            if not re.fullmatch(r'xl/worksheets/[^/]+\.xml', name):
                continue
            result['sheets'] += 1
            shared_formulas = {}
            with z.open(name) as f:
                for event, e in ET.iterparse(f, events=('end',)):
                    tag = local(e.tag)
                    if tag == 'c':
                        typ = e.attrib.get('t', '')
                        value = next((x.text or '' for x in e if local(x.tag) == 'v'), '')
                        formula_node = next((x for x in e if local(x.tag) == 'f'), None)
                        formula = formula_node.text or '' if formula_node is not None else ''
                        if formula_node is not None and formula_node.attrib.get('t') == 'shared':
                            shared_id = formula_node.attrib.get('si', '')
                            if formula:
                                shared_formulas[shared_id] = (e.attrib.get('r'), formula)
                            else:
                                try:
                                    from openpyxl.formula.translate import Translator
                                    origin, original = shared_formulas[shared_id]
                                    formula = Translator('=' + original, origin=origin).translate_formula(e.attrib['r']).lstrip('=')
                                except Exception:
                                    warning = '部分共享公式无法展开，仅计入已保存值'
                                    if warning not in result['unknownParts']: result['unknownParts'].append(warning)
                        if typ == 's' and value:
                            try: value = strings[int(value)]
                            except (IndexError, ValueError): raise ValueError('共享字符串索引异常，统计不完整')
                        elif typ == 'inlineStr':
                            value = ''.join(x.text or '' for x in e.iter() if local(x.tag) == 't')
                        if formula:
                            counter.add('=' + formula)
                            result['formulas'] += 1
                            if not value:
                                warning = '部分公式没有缓存结果，未重新计算公式'
                                if warning not in result['unknownParts']: result['unknownParts'].append(warning)
                        if value or formula:
                            result['cells'] += 1
                            counter.add(value)
                            counter.add('\t')
                        e.clear()
                    elif tag == 'row':
                        e.clear()
        # Include notes, text boxes, chart labels and defined names separately.
        for name in sorted(names):
            if re.fullmatch(r'xl/(?:comments[^/]*|drawings/[^/]+|charts/[^/]+)\.xml', name):
                root = ET.fromstring(z.read(name))
                for e in root.iter():
                    if local(e.tag) in ('t', 'text') and e.text:
                        counter.add(e.text)
        embedded = sum(1 for n in names if n.startswith(('xl/media/', 'xl/embeddings/')))
        if embedded:
            result['unknownParts'].append(f'{embedded} 个内嵌图像/对象未做视觉分词')
        if any(n.startswith('xl/externalLinks/') for n in names):
            result['unknownParts'].append('外部链接目标内容未读取')
        if 'xl/vbaProject.bin' in names:
            result['unknownParts'].append('宏二进制内容未计入')

def office_xml(path, counter, result, prefix):
    with zipfile.ZipFile(path) as z:
        if sum(i.file_size for i in z.infolist()) > MAX_UNPACKED:
            raise ValueError('解压后体积过大，统计不完整')
        for name in z.namelist():
            if name.startswith(prefix) and name.endswith('.xml'):
                root = ET.fromstring(z.read(name))
                for e in root.iter():
                    if local(e.tag) in ('t', 'v') and e.text: counter.add(e.text)
        if any('/media/' in n or '/embeddings/' in n for n in z.namelist()):
            result['unknownParts'].append('内嵌图像/对象未做视觉分词')

def scan(item):
    path = item['path']
    result = dict(key=item['key'], status='parsed', unknownParts=[], **Counter().result())
    counter = Counter()
    try:
        size = os.path.getsize(path)
        result['fileBytes'] = size
        if size > MAX_BYTES: raise ValueError('附件超过 256 MiB，本地扫描未完成')
        ext = os.path.splitext(path)[1].lower()
        if ext in ('.xlsx', '.xlsm', '.xltx', '.xltm'):
            xlsx_scan(path, counter, result)
        elif ext == '.xls':
            import xlrd, io
            try:
                book = xlrd.open_workbook(path, on_demand=True, logfile=io.StringIO())
                result.update(sheets=book.nsheets, hiddenSheets=0, cells=0, formulaCoverage='已保存的单元格值；旧格式公式源码不保证可见')
                try:
                    for n in range(book.nsheets):
                        sheet = book.sheet_by_index(n)
                        counter.add(sheet.name)
                        if sheet.visibility: result['hiddenSheets'] += 1
                        for row in sheet.get_rows():
                            for cell in row:
                                if cell.ctype not in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                                    counter.add(cell.value); counter.add('\t'); result['cells'] += 1
                        book.unload_sheet(n)
                finally: book.release_resources()
                result['unknownParts'].append('XLS 计入已保存单元格值；公式源码、嵌入对象不能保证完整')
            except Exception as xls_err:
                # 兼容银行等系统导出的伪装成 .xls 的 HTML / XML / 纯文本表格
                try:
                    with open(path, 'rb') as f:
                        raw = f.read()
                    sample = raw[:4096].lower()
                    if b'<html' in sample or b'<table' in sample or b'<?xml' in sample:
                        text = None
                        for encoding in ('utf-8-sig', 'utf-16', 'gb18030', 'gbk', 'utf-8'):
                            try: text = raw.decode(encoding); break
                            except UnicodeError: pass
                        if text is not None:
                            counter.add(text)
                            result['unknownParts'].append('文件为 HTML/XML 格式的表格导出，已按文本提取')
                        else:
                            raise xls_err
                    else:
                        raise xls_err
                except Exception:
                    raise xls_err
        elif ext == '.xlsb':
            from pyxlsb import open_workbook
            with open_workbook(path) as book:
                result.update(sheets=len(book.sheets), cells=0, formulaCoverage='已保存的单元格值')
                for n, name in enumerate(book.sheets, 1):
                    counter.add(name)
                    with book.get_sheet(n) as sheet:
                        for row in sheet.rows(sparse=True):
                            for cell in row:
                                if cell.v is not None:
                                    counter.add(cell.v); counter.add('\t'); result['cells'] += 1
            result['unknownParts'].append('XLSB 计入已保存单元格值；公式源码、嵌入对象不能保证完整')
        elif ext == '.docx': office_xml(path, counter, result, 'word/')
        elif ext == '.pptx': office_xml(path, counter, result, 'ppt/')
        elif ext == '.pdf':
            from pypdf import PdfReader
            reader = PdfReader(path)
            result['pages'] = len(reader.pages)
            for page in reader.pages:
                text = page.extract_text() or ''
                counter.add(text)
                if not text.strip(): result['unknownParts'].append('存在无文本页，扫描图内容未计全')
                if page.images: result['unknownParts'].append('PDF 图像未做视觉分词')
        elif ext in ('.txt', '.csv', '.tsv', '.md', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.html', '.htm', '.log', '.py', '.js', '.ts', '.css', '.sql', '.rtf'):
            with open(path, 'rb') as text_file:
                raw = text_file.read()
            text = None
            for encoding in ('utf-8-sig', 'utf-16', 'gb18030'):
                try: text = raw.decode(encoding); break
                except UnicodeError: pass
            if text is None: raise ValueError('文本编码无法识别')
            counter.add(text)
        else:
            if ext in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif'):
                try:
                    from PIL import Image
                    with Image.open(path) as image: result['width'], result['height'] = image.size
                except Exception: pass
                raise ValueError('图像/截图的视觉 token 无可靠本地计数，明确列为未知')
            raise ValueError('此附件类型暂不支持内容解析，明确列为未知')
    except Exception as e:
        result['unknownParts'].append(str(e)[:180])
    result.update(counter.result())
    result['unknownParts'] = list(dict.fromkeys(result['unknownParts']))
    if result['unknownParts']: result['status'] = 'partial' if counter.chars else 'unknown'
    return result

if __name__ == '__main__':
    payload = json.load(sys.stdin)
    if '--json-lines' in sys.argv:
        for item in payload:
            print(json.dumps(scan(item), ensure_ascii=True), flush=True)
    else:
        json.dump([scan(item) for item in payload], sys.stdout, ensure_ascii=True)
