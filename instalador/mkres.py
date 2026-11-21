# gera rsrc_windows_amd64.syso: ícone + manifesto (pede administrador) + versão, sem ferramentas externas
import struct,sys
ico=open(sys.argv[1],'rb').read(); ver=sys.argv[2]; out=sys.argv[3]
_,typ,n=struct.unpack('<HHH',ico[:6]); imgs=[];grp=struct.pack('<HHH',0,1,n)
for i in range(n):
    w,h,c,r,pl,bpp,sz,off=struct.unpack('<BBBBHHII',ico[6+16*i:22+16*i])
    imgs.append(ico[off:off+sz]); grp+=struct.pack('<BBBBHHIH',w,h,c,r,pl,bpp,sz,i+1)
man=('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">\n'
 '<assemblyIdentity version="1.0.0.0" processorArchitecture="amd64" name="MercadoOnline.Setup" type="win32"/>\n<description>Instalador Mercado Online</description>\n'
 '<trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="requireAdministrator" uiAccess="false"/></requestedPrivileges></security></trustInfo>\n'
 '<compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/><supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/></application></compatibility>\n'
 '<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true</dpiAware></windowsSettings></application>\n</assembly>\n').encode()
# VS_VERSIONINFO
def wstr(s): return (s+'\0').encode('utf-16le')
def pad4(b): return b+b'\0'*((4-len(b)%4)%4)
def blk(key,val=b'',typ=1,children=b'',vlen=None):
    h=wstr(key); body=pad4(struct.pack('<HHH',0,0,0)+h)[6:]  # placeholder
    head=struct.pack('<HHH',0,vlen if vlen is not None else (len(val)//2 if typ==1 else len(val)),typ)+h
    head=pad4(head); data=pad4(head+val)+children
    return struct.pack('<H',len(data))+data[2:]
def sblk(k,v): return pad4(blk(k,wstr(v),1,vlen=len(v)+1))
strs=b''.join(sblk(k,v) for k,v in [('CompanyName','Mercado Online'),('FileDescription','Instalador Mercado Online'),('FileVersion',ver),('ProductName','Mercado Online'),('ProductVersion',ver),('OriginalFilename','MercadoOnline-Setup.exe'),('LegalCopyright','Mercado Online')])
st=blk('041604b0',b'',1,strs,vlen=0); sfi=blk('StringFileInfo',b'',1,pad4(st),vlen=0)
vfi=blk('VarFileInfo',b'',1,pad4(blk('Translation',struct.pack('<HH',0x0416,1200),0)),vlen=0)
ffi=struct.pack('<IIIIIIIIIIIII',0xFEEF04BD,0x10000,1,0,1,0,0x3F,0,0x40004,1,0,0,0)
vs=blk('VS_VERSION_INFO',ffi,0,pad4(sfi)+pad4(vfi))
# árvore: tipo -> [(id, dado)]
T=[(3,[(i+1,d) for i,d in enumerate(imgs)]),(14,[(1,grp)]),(24,[(1,man)])]
LANG=0x0416
# layout: dir raiz, dirs de tipo, dirs de id, data entries, dados
def dirsz(k): return 16+8*k
off=dirsz(len(T)); tdirs=[];
for t,l in T: tdirs.append(off); off+=dirsz(len(l))
idirs=[]
for t,l in T:
    row=[]
    for _ in l: row.append(off); off+=dirsz(1)
    idirs.append(row)
dents=[]
for t,l in T:
    row=[]
    for _ in l: row.append(off); off+=16
    dents.append(row)
datas=[]
for t,l in T:
    row=[]
    for _,d in l:
        off=(off+7)&~7; row.append(off); off+=len(d)
    datas.append(row)
buf=bytearray(off); relocs=[]
def wdir(at,entries):
    struct.pack_into('<IIHHHH',buf,at,0,0,0,0,0,len(entries))
    for j,(idv,ptr) in enumerate(entries): struct.pack_into('<II',buf,at+16+8*j,idv,ptr)
wdir(0,[(t,0x80000000|tdirs[k]) for k,(t,l) in enumerate(T)])
for k,(t,l) in enumerate(T):
    wdir(tdirs[k],[(idv,0x80000000|idirs[k][j]) for j,(idv,_) in enumerate(l)])
    for j,(idv,d) in enumerate(l):
        wdir(idirs[k][j],[(LANG,dents[k][j])])
        struct.pack_into('<IIII',buf,dents[k][j],datas[k][j],len(d),0,0); relocs.append(dents[k][j])
        buf[datas[k][j]:datas[k][j]+len(d)]=d
raw=bytes(buf); 
hdr=20; sec=40; praw=hdr+sec; prel=praw+len(raw); psym=prel+10*len(relocs)
o=struct.pack('<HHIIIHH',0x8664,1,0,psym,1,0,0)
o+=struct.pack('<8sIIIIIIHHI',b'.rsrc',0,0,len(raw),praw,prel,0,len(relocs),0,0x40000040)
o+=raw
for r in relocs: o+=struct.pack('<IIH',r,0,3)
o+=struct.pack('<8sIhHBB',b'.rsrc',0,1,0,3,0)+struct.pack('<I',4)
open(out,'wb').write(o); print('syso',len(o),'bytes,',n,'ícones')
