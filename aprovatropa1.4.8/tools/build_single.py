"""Gera um index.html único (CSS, JS e PDF.js embutidos) a partir de app/. Uso: python3 tools/build_single.py"""
import re,base64
b='app/'
h=open(b+'index.html',encoding='utf-8').read()
css=open(b+'css/app.css',encoding='utf-8').read(); appjs=open(b+'js/app.js',encoding='utf-8').read(); authjs=open(b+'js/auth/auth.js',encoding='utf-8').read()
e64=lambda p: base64.b64encode(open(p,'rb').read()).decode()
pdf='<script>window.__PDFJS_B64={lib:"%s",worker:"%s"};</script>\n'%(e64(b+'pdfjs/pdf.min.mjs'),e64(b+'pdfjs/pdf.worker.min.mjs'))
h=re.sub(r'<link rel="stylesheet" href="css/app.css">','<style>\n'+css+'\n</style>',h,count=1)
def _inline(m):
    return '<script>\n'+open(b+m.group(1),encoding='utf-8').read()+'\n</script>'
h=re.sub(r'<script src="(js/[^"]+)"></script>',_inline,h)
h=h.replace('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>','<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>\n'+pdf,1)
h=re.sub(r'<link rel="manifest"[^>]*>','',h)
import glob,os
for f in glob.glob(b+'assets/**/*.png',recursive=True):
    rel=os.path.relpath(f,b)
    h=h.replace('src="'+rel+'"','src="data:image/png;base64,'+e64(f)+'"')
assert 'src="js/' not in h and 'href="css/' not in h
open('index.html','w',encoding='utf-8').write(h); print('index.html único:',len(h)//1024,'KB')
