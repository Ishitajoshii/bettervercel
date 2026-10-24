import json
import re
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle, KeepTogether
from reportlab.graphics.shapes import Drawing, Rect, String, Line, Polygon
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent
data = json.loads((ROOT / 'paper_content.json').read_text(encoding='utf-8'))
for name, file in [('TimesPaper','times.ttf'),('TimesPaperBold','timesbd.ttf'),('TimesPaperItalic','timesi.ttf'),('TimesPaperBoldItalic','timesbi.ttf')]:
    pdfmetrics.registerFont(TTFont(name, str(Path('C:/Windows/Fonts') / file)))
pdfmetrics.registerFontFamily('TimesPaper', normal='TimesPaper', bold='TimesPaperBold', italic='TimesPaperItalic', boldItalic='TimesPaperBoldItalic')
W,H=612,792
M=45
CW=252
GAP=18
BOTTOM=72
TOP=54
TITLE_H=84
styles={
 'body':ParagraphStyle('body',fontName='TimesPaper',fontSize=10,leading=11.3,alignment=TA_JUSTIFY,firstLineIndent=10,spaceAfter=1.5,allowWidows=0,allowOrphans=0),
 'abstract':ParagraphStyle('abstract',fontName='TimesPaperBold',fontSize=9,leading=10.5,alignment=TA_JUSTIFY,spaceAfter=7),
 'head':ParagraphStyle('head',fontName='TimesPaper',fontSize=10,leading=12,alignment=TA_CENTER,spaceBefore=9,spaceAfter=6,keepWithNext=True),
 'sub':ParagraphStyle('sub',fontName='TimesPaperItalic',fontSize=10,leading=12,spaceBefore=6,spaceAfter=4,keepWithNext=True),
 'caption':ParagraphStyle('caption',fontName='TimesPaper',fontSize=8,leading=9.5,spaceAfter=7),
 'ref':ParagraphStyle('ref',fontName='TimesPaper',fontSize=8,leading=9.5,alignment=TA_LEFT,leftIndent=14,firstLineIndent=-14,spaceAfter=4,splitLongWords=True),
 'cell':ParagraphStyle('cell',fontName='TimesPaper',fontSize=8,leading=9,alignment=TA_CENTER),
}
def p(t, style='body'):
    return Paragraph(escape(t),styles[style])

def first(canvas,doc):
    title=Paragraph('Better Vercel for Immutable<br/>Static Web Previews on AWS',ParagraphStyle('title',fontName='TimesPaper',fontSize=24,leading=27,alignment=TA_CENTER))
    _,height=title.wrap(W-2*M,80)
    title.drawOn(canvas,M,H-TOP-height)

def frames(height, y=BOTTOM):
    return [Frame(M,y,CW,height,id='left',leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0),Frame(M+CW+GAP,y,CW,height,id='right',leftPadding=0,rightPadding=0,topPadding=0,bottomPadding=0)]

def body_page(canvas,doc):
    if doc.page == 3: doc.handle_nextPageTemplate('last')

doc=BaseDocTemplate(str(ROOT/'bettervercel-ieee-paper.pdf'),pagesize=(W,H),leftMargin=M,rightMargin=M,topMargin=TOP,bottomMargin=BOTTOM,title=data['title'],author='',subject='IEEE-style systems paper on static preview hosting',pageCompression=1)
doc.addPageTemplates([PageTemplate(id='first',frames=frames(H-TOP-BOTTOM-TITLE_H),onPage=first,autoNextPageTemplate='body'),PageTemplate(id='body',frames=frames(H-TOP-BOTTOM),onPage=body_page),PageTemplate(id='last',frames=frames(550,H-TOP-550))])

def diagram():
    d=Drawing(CW,180)
    def box(x,y,w,h,lines):
        d.add(Rect(x,y,w,h,fillColor=colors.white,strokeColor=colors.black,strokeWidth=.6))
        for i,t in enumerate(lines): d.add(String(x+w/2,y+h-12-i*10,t,fontName='TimesPaper',fontSize=8.5,textAnchor='middle'))
    def arrow(x1,y1,x2,y2):
        d.add(Line(x1,y1,x2,y2,strokeWidth=.7))
        import math
        a=math.atan2(y2-y1,x2-x1)
        pts=[x2,y2,x2-5*math.cos(a-.45),y2-5*math.sin(a-.45),x2-5*math.cos(a+.45),y2-5*math.sin(a+.45)]
        d.add(Polygon(pts,fillColor=colors.black,strokeColor=colors.black))
    box(3,141,104,32,['CLI or Actions runner','Build and manifest'])
    box(145,141,104,32,['API Gateway + Lambda','Control and validation'])
    box(3,65,104,32,['Private S3','Immutable artifact keys'])
    box(145,65,104,32,['DynamoDB','Projects / state / sessions'])
    box(3,3,104,32,['Viewer via CloudFront','Request routing + cache'])
    arrow(107,157,145,157)
    d.add(String(126,166,'API',fontName='TimesPaper',fontSize=7,textAnchor='middle'))
    arrow(55,141,55,97)
    d.add(String(59,118,'Signed PUT',fontName='TimesPaper',fontSize=7))
    arrow(197,141,197,97)
    d.add(String(200,119,'State',fontName='TimesPaper',fontSize=7))
    arrow(145,144,106,97)
    d.add(String(129,107,'Verify',fontName='TimesPaper',fontSize=7))
    arrow(55,35,55,65)
    d.add(String(59,47,'OAC read',fontName='TimesPaper',fontSize=7))
    return KeepTogether([d,p('Fig. 1. Build, control, and delivery paths. Artifact uploads go directly to S3; viewer requests do not consult deployment state.','caption')])

rows=[['Fixture','Files','Bytes','Time (s)','Boundary'],['Vite SPA','3','2,544','1.983','Post-build'],['Vite static','3','2,534','1.240','Post-build'],['Vite CLI','3','2,430','5.609','With build'],['Next static','19','398,084','16.004','With build']]
def results_table():
    tbl=Table([[p(c,'cell') for c in row] for row in rows],colWidths=[61,27,53,47,64],repeatRows=1,hAlign='CENTER')
    tbl.setStyle(TableStyle([('LINEABOVE',(0,0),(-1,0),.6,colors.black),('LINEBELOW',(0,0),(-1,0),.4,colors.black),('LINEBELOW',(0,-1),(-1,-1),.6,colors.black),('TOPPADDING',(0,0),(-1,-1),4),('BOTTOMPADDING',(0,0),(-1,-1),4),('LEFTPADDING',(0,0),(-1,-1),2),('RIGHTPADDING',(0,0),(-1,-1),2),('VALIGN',(0,0),(-1,-1),'MIDDLE')]))
    caption=Paragraph('TABLE I<br/>OBSERVED DEPLOYMENT TIMES',ParagraphStyle('tablecap',parent=styles['caption'],alignment=TA_CENTER,spaceAfter=5))
    return KeepTogether([caption,tbl,Spacer(1,5),p('One observation per fixture. Post-build timing excludes the later HTTP content checks. With-build timing uses a different measurement boundary. Source: retained verification records [7].','caption')])

story=[Paragraph('<b><i>Abstract—</i></b>'+escape(data['abstract']),styles['abstract']),Paragraph('<b><i>Index Terms—</i></b>'+escape(data['keywords']),styles['abstract'])]
roman=['I','II','III','IV','V','VI','VII','VIII']
for n,section in enumerate(data['sections']):
    story.append(p(roman[n]+'. '+section['title'].upper(),'head'))
    if n==5: story.append(results_table())
    for para in section.get('paragraphs',[]): story.append(p(para))
    for sn,sub in enumerate(section.get('subsections',[])):
        story.append(p(chr(65+sn)+'. '+sub['title'],'sub'))
        for para in sub['paragraphs']: story.append(p(para))
        if n==2 and sn==0: story.append(diagram())
story.append(p('REFERENCES','head'))
for n,r in enumerate(data['references'],1):
    text=escape(f'[{n}] '+r['text'])
    if r.get('url'):
        url=r['url']
        display=escape(url).replace('/', '/\u200b').replace('-', '-\u200b').replace('.', '.\u200b')
        text+=' <link href="'+escape(url)+'" color="black">'+display+'</link>'
    story.append(KeepTogether([Paragraph(text,styles['ref'])]))
doc.build(story)

def tex(t):
    mapping={'\\':r'\textbackslash{}','&':r'\&','%':r'\%','$':r'\$','#':r'\#','_':r'\_','{':r'\{','}':r'\}','~':r'\textasciitilde{}','^':r'\textasciicircum{}'}
    s=''.join(mapping.get(c,c) for c in t)
    return re.sub(r'\[(\d+)\]',lambda m:r'\cite{r'+m[1]+'}',s)
out=[r'\documentclass[conference,letterpaper]{IEEEtran}',r'\usepackage[T1]{fontenc}',r'\usepackage{newtxtext,newtxmath}',r'\usepackage{graphicx,booktabs,url}',r'\usepackage[hidelinks]{hyperref}',r'\usepackage{tikz}',r'\usetikzlibrary{positioning,arrows.meta}',r'\title{'+tex(data['title'])+'}',r'% Add verified author, affiliation, and email information here before submission.',r'% \author{\IEEEauthorblockN{Author Name}\IEEEauthorblockA{Department and Institution\\City, Country\\email@example.com}}',r'\begin{document}',r'\maketitle',r'\begin{abstract}',tex(data['abstract']),r'\end{abstract}',r'\begin{IEEEkeywords}',tex(data['keywords']),r'\end{IEEEkeywords}']
for n,s in enumerate(data['sections']):
    out.append(r'\section{'+tex(s['title'])+'}')
    if n==2:
        out.extend([r'\begin{figure}[t]\centering',r'\begin{tikzpicture}[node distance=12mm and 7mm, every node/.style={font=\scriptsize}, box/.style={draw,align=center,text width=24mm,minimum height=9mm}, >=Stealth]',r'\node[box] (client) {CLI or Actions\\Build and manifest};',r'\node[box,right=of client] (api) {API Gateway\\and Lambda};',r'\node[box,below=of client] (s3) {Private S3\\Artifact objects};',r'\node[box,below=of api] (db) {DynamoDB\\State and sessions};',r'\node[box,below=of s3] (cdn) {Viewer via CloudFront\\Routing and cache};',r'\draw[->] (client) -- (api); \draw[->] (client) -- node[left]{PUT} (s3);',r'\draw[->] (api) -- (db); \draw[->] (api) -- node[right]{Verify} (s3);',r'\draw[->] (cdn) -- node[left]{OAC read} (s3);',r'\end{tikzpicture}',r'\caption{Build, control, and delivery paths. Artifact uploads go directly to S3; viewer requests do not consult deployment state.}\label{fig:architecture}',r'\end{figure}'])
    if n==5:
        out.extend([r'\begin{table}[t]\caption{Observed Deployment Times}\label{tab:results}\centering\footnotesize',r'\begin{tabular}{lrrrr}\toprule'])
        for i,row in enumerate(rows):
            out.append(' & '.join(tex(c) for c in row)+r' \\')
            if i==0: out.append(r'\midrule')
        out.extend([r'\bottomrule\end{tabular}',r'\par\smallskip\raggedright One observation per fixture. Post-build timing excludes later HTTP content checks; with-build timing uses a different boundary. Source: \cite{r7}.',r'\end{table}'])
    for t in s.get('paragraphs',[]): out.extend([tex(t),''])
    for sub in s.get('subsections',[]):
        out.append(r'\subsection{'+tex(sub['title'])+'}')
        for t in sub['paragraphs']: out.extend([tex(t),''])
out.append(r'\begin{thebibliography}{00}')
for n,r in enumerate(data['references'],1):
    out.append(r'\bibitem{r'+str(n)+'} '+tex(r['text'])+(r' \url{'+r['url']+'}.' if r.get('url') else ''))
out.extend([r'\end{thebibliography}',r'\end{document}'])
(ROOT/'bettervercel-ieee-paper.tex').write_text('\n'.join(out)+'\n',encoding='utf-8')
reader=PdfReader(ROOT/'bettervercel-ieee-paper.pdf')
print(json.dumps({'pages':len(reader.pages),'words':sum(len(page.extract_text().split()) for page in reader.pages),'pdf_bytes':(ROOT/'bettervercel-ieee-paper.pdf').stat().st_size}))
