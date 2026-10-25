import unittest, os, shutil, zipfile, json, subprocess, pathlib
from attachment_scan import scan, Counter

ROOT = pathlib.Path(__file__).resolve().parent / 'test-fixtures'

class ScanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ROOT.mkdir(exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(ROOT, ignore_errors=True)
    def fixture(self, name, extra=None):
        path = ROOT / name
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('xl/workbook.xml', '<workbook><sheets><sheet name="visible"/><sheet name="hidden" state="veryHidden"/></sheets></workbook>')
            z.writestr('xl/sharedStrings.xml', '<sst><si><t>中文</t></si><si><r><t>rich</t></r><r><t> text</t></r></si></sst>')
            z.writestr('xl/worksheets/sheet1.xml', '<worksheet><dimension ref="A1:XFD1048576"/><sheetData><row><c t="s"><v>0</v></c><c><v>0</v></c><c><f>SUM(A1:A2)</f><v>42</v></c><c s="1"/></row></sheetData></worksheet>')
            z.writestr('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>hidden text</t></is></c></row></sheetData></worksheet>')
            for n, v in (extra or {}).items(): z.writestr(n, v)
        return str(path)
    def test_all_sheets_shared_strings_zero_formulas_and_cached_values(self):
        path = self.fixture('all-sheets.xlsx')
        r = scan(dict(path=path, key='x'))
        self.assertEqual(r['status'], 'parsed'); self.assertEqual(r['sheets'], 2); self.assertEqual(r['hiddenSheets'], 1)
        self.assertEqual(r['cells'], 5); self.assertEqual(r['formulas'], 1)
        c = Counter()
        for text in ['visible','hidden','中文','\t','0','\t','=SUM(A1:A2)','42','\t','中文','\t','hidden text','\t']: c.add(text)
        self.assertEqual(r['chars'], c.chars); self.assertEqual(r['bytes'], c.bytes)
    def test_image_macro_and_external_link_are_flagged_not_silently_counted_as_zero(self):
        path = self.fixture('embedded.xlsm', {'xl/media/image.png': b'not-a-real-image', 'xl/vbaProject.bin': b'NEVER EXECUTE', 'xl/externalLinks/externalLink1.xml': '<x/>'})
        r = scan(dict(path=path, key='x')); self.assertEqual(r['status'], 'partial'); self.assertEqual(len(r['unknownParts']), 3)
    def test_corrupt_encrypted_or_missing_file_never_reported_complete(self):
        path = ROOT / 'broken.xlsx'; path.write_bytes(b'not a zip')
        for p in [str(path), str(ROOT / 'missing.xlsx')]: self.assertEqual(scan(dict(path=p,key='x'))['status'], 'unknown')
    def test_large_blank_dimension_does_not_inflate_cells(self):
        r = scan(dict(path=self.fixture('sparse.xlsx'),key='x')); self.assertEqual(r['cells'], 5)
    def test_utf16_csv_preserves_chinese_and_zero(self):
        path = ROOT / 'unicode.csv'; path.write_bytes('姓名,金额\n甲,0\n'.encode('utf-16'))
        r = scan(dict(path=str(path),key='x')); self.assertEqual(r['status'],'parsed'); self.assertEqual(r['chars'],len('姓名,金额\n甲,0\n'))
    def test_numeric_zero_is_measured(self):
        c = Counter(); c.add(0); self.assertEqual(c.chars,1)
    def test_shared_formulas_are_expanded_and_counted(self):
        path = ROOT / 'shared.xlsx'
        with zipfile.ZipFile(path,'w') as z:
            z.writestr('xl/workbook.xml','<workbook><sheets><sheet name="s"/></sheets></workbook>')
            z.writestr('xl/worksheets/sheet1.xml','<worksheet><sheetData><row><c r="B1"><f t="shared" si="0">A1+1</f><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>3</v></c></row></sheetData></worksheet>')
        r=scan(dict(path=str(path),key='x')); self.assertEqual(r['status'],'parsed'); self.assertEqual(r['formulas'],2)
        c=Counter()
        for t in ['s','=A1+1','2','\t','=A2+1','3','\t']: c.add(t)
        self.assertEqual(r['chars'],c.chars)
    def test_html_table_disguised_as_xls_is_parsed(self):
        path = ROOT / 'bank_export.xls'
        path.write_bytes('<html><body><table><tr><td>交易时间</td><td>金额</td></tr><tr><td>2026-10-25</td><td>100.00</td></tr></table></body></html>'.encode('utf-8'))
        r = scan(dict(path=str(path), key='x'))
        self.assertIn(r['status'], ('parsed', 'partial'))
        self.assertTrue(r['chars'] > 0)
        self.assertTrue(any('HTML/XML' in part for part in r['unknownParts']))

if __name__ == '__main__': unittest.main()
