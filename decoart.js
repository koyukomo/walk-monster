// おもちゃ・飾りのドット絵(コードで描く)。持ち物のアイコンと同じ描き方: 光は左上から、輪郭は暗い色(自動)
// DECOART.img(id) → 画像の dataURL(作ったものは覚えておく)。DECOART.sz[id] = [横, 縦](ドット)
// 動く部分は別の絵: windmill_b(風車の羽根・回す)/fire_f(たき火の炎・ゆらす)/flag_f(旗の布・なびかせる)/fount_w(噴水の水・ゆらす)/bub_b(シャボン玉)
(function(){
const SZ={tree:[32,42],fount:[36,30],fount_w:[36,30],tent:[38,30],windmill:[30,46],windmill_b:[30,30],statue:[24,42],flag:[22,42],flag_f:[22,42],fire:[24,22],fire_f:[24,22],bench:[34,18],
bed:[30,14],flower:[12,18],kino:[16,15],rock:[18,12],
ball:[16,16],tsumiki:[18,16],nui:[16,18],taiko:[18,16],bub:[16,18],bub_b:[16,18],nawa:[20,16]};
const OL='#150e16',C={};
function draw(id){const[W,H]=SZ[id],A=new Array(W*H).fill(0),L=new Array(W*H).fill(0);let noOL=0;
const p=(x,y,c,B=A)=>{x=Math.floor(x);y=Math.floor(y);if(c&&x>=0&&y>=0&&x<W&&y<H)B[y*W+x]=c},
r=(x,y,w,h,c)=>{for(let j=0;j<h;j++)for(let i=0;i<w;i++)p(x+i,y+j,typeof c=='function'?c(i,j,w,h):c)},
e=(cx,cy,rx,ry,c)=>{for(let j=Math.floor(cy-ry);j<=cy+ry;j++)for(let i=Math.floor(cx-rx);i<=cx+rx;i++){const u=(i+.5-cx)/rx,v=(j+.5-cy)/ry;if(u*u+v*v<=1)p(i,j,typeof c=='function'?c(u,v):c)}},
// 3色の陰影(左上が明るい・右下が暗い)
sh=(P,a=.6,b=.55)=>(u,v)=>u+v<-a?P[0]:u+v>b?P[2]:P[1],
ln=(x0,y0,x1,y1,c)=>{const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0))*2+1;for(let k=0;k<=n;k++)p(x0+(x1-x0)*k/n,y0+(y1-y0)*k/n,c)},
tw=(x,y)=>{p(x,y,'#ffffff',L);[[1,0],[-1,0],[0,1],[0,-1]].forEach(([a,b])=>p(x+a,y+b,'#fff4b8',L))},
GR=['#a8ec70','#4cb83a','#2c8a2c'],WD=['#d89a5a','#a0642a','#6a3e18'],ST=['#e4e4ee','#a8a8b8','#6a6a7c'];
// ---- 奥(大きい飾り) ----
if(id=='tree'){r(14,26,5,15,(i,j)=>i==0?WD[0]:i>=3?WD[2]:WD[1]);p(13,40,WD[1]);p(19,40,WD[2]);p(12,41,WD[1]);p(20,41,WD[2]);r(13,41,7,1,WD[1]);[[16,30],[15,34],[17,37]].forEach(([x,y])=>p(x,y,'#4a2a10'));
const lf=(cx,cy,rx,ry)=>e(cx,cy,rx,ry,(u,v)=>u+v<-.75?'#c8f490':u+v<-.2?GR[0]:u+v>.7?'#1e6a24':u+v>.2?GR[2]:GR[1]);
lf(16,24,13,6);lf(9,18,7.5,6.5);lf(23,18,7.5,6.5);lf(16,12,9.5,8);lf(16,6,6,5);
[[9,14],[14,8],[20,13],[6,20],[24,22],[12,22]].forEach(([x,y])=>{p(x,y,'#e8ffd0');p(x+1,y,'#c8f490')});
[[22,20,'#ff5a6a'],[10,24,'#ff5a6a'],[18,10,'#ff5a6a'],[25,15,'#ff5a6a']].forEach(([x,y,c])=>{p(x,y,c);p(x+1,y,'#a81828');p(x,y-1,'#ffc0c8')})}
else if(id=='fount'||id=='fount_w'){if(id=='fount'){
// 下の池(楕円)・ふち(石)・柱・上の皿
e(18,24,17,5.5,(u,v)=>v<-.2?(u<-.5?ST[0]:ST[1]):ST[2]);e(18,23.5,14,3.6,(u,v)=>u+v<-.5?'#c8f0ff':v>.3?'#2a78c8':'#4aa8f0');
r(1,24,34,4,(i,j,w)=>j==3?'#4a4a5a':i<6?ST[0]:i>w-6?ST[2]:ST[1]);r(15,11,6,11,i=>i==0?ST[0]:i>=4?ST[2]:ST[1]);
e(18,11,8,2.6,(u,v)=>v<0?'#6ac0ff':ST[2]);r(10,11,16,2,(i,j)=>j?ST[2]:i<4?ST[0]:ST[1]);r(16,5,4,6,i=>i==0?ST[0]:i==3?ST[2]:ST[1]);e(18,5,3,1.5,'#6ac0ff')}
else{noOL=1;const Wt=['#ffffffd8','#bfe8ffd0','#7ac8ffc0'];
// 上から吹き出す水と、皿からこぼれる水
for(let k=0;k<5;k++){p(18,4-k*.8,Wt[0]);}ln(17,2,13,6,Wt[1]);ln(19,2,23,6,Wt[1]);ln(13,6,11,10,Wt[2]);ln(23,6,25,10,Wt[2]);
ln(10,12,8,22,Wt[1]);ln(26,12,28,22,Wt[1]);ln(11,12,10,21,Wt[2]);ln(25,12,26,21,Wt[2]);[[9,23],[27,23],[14,23],[22,23]].forEach(([x,y])=>{p(x,y,Wt[0]);p(x+1,y,Wt[1])})}}
else if(id=='tent'){const R=['#ff8a7a','#e83a3a','#9a1a20'],Y=['#fff8d8','#f4e0a0','#b89a58'];
for(let j=0;j<24;j++){const hw=1+j*.75;for(let i=Math.floor(19-hw);i<19+hw;i++){const d=i+.5-19,s=Math.floor((d+40)/3.2)%2;p(i,j+4,s?(d<-hw+2?R[0]:d>hw-2.5?R[2]:R[1]):(d<-hw+2?Y[0]:d>hw-2.5?Y[2]:Y[1]))}}
r(1,27,36,2,(i,j)=>j?'#6a3e18':'#a0642a');for(let j=14;j<28;j++){const hw=(j-14)*.42;r(Math.floor(19-hw),j,Math.ceil(hw*2),1,'#3a1a20')}
r(18,0,1,5,'#6a3e18');r(19,0,4,3,(i,j)=>j==2?'#2a78c8':'#4aa8f0');ln(4,27,0,29,'#6a3e18');ln(33,27,37,29,'#6a3e18')}
else if(id=='windmill'){const B=['#fff4dc','#e8d0a0','#a88a58'];
for(let j=10;j<44;j++){const hw=5+(j-10)*.14;for(let i=Math.floor(15-hw);i<15+hw;i++){const d=(i+.5-15)/hw;p(i,j,d<-.55?B[0]:d>.45?B[2]:B[1])}}
for(let j=2;j<12;j++){const hw=Math.min(7,(j-1)*.9);for(let i=Math.floor(15-hw);i<15+hw;i++){const d=(i+.5-15)/hw;p(i,j,d<-.4?'#ff8a6a':d>.4?'#8a2418':'#d04a30')}}
r(12,32,6,12,(i,j)=>j==0?'#3a1a10':i==0?'#8a5a30':'#5a3418');r(10,19,4,4,(i,j)=>i==0||j==0?'#c8f0ff':'#4aa8f0');r(17,23,4,4,(i,j)=>i==0||j==0?'#c8f0ff':'#4aa8f0');r(4,43,22,1,'#6a3e18');e(15,14,2.2,2.2,ST[2])}
else if(id=='windmill_b'){const S=['#fffaf0','#e8dcc0','#a8946a'];
// 4枚の羽根(中心 15,15)
for(let k=0;k<4;k++){const a=k*Math.PI/2+.25,cx=Math.cos(a),sy=Math.sin(a),px=-sy,py=cx;for(let t=2;t<14;t++)for(let w=-2.5;w<=2.5;w+=.5){const x=15+cx*t+px*w,y=15+sy*t+py*w;p(x,y,Math.abs(w)<.6?'#6a3e18':(Math.floor(t/3)+(w>0?1:0))%2?S[1]:w<0?S[0]:S[2])}}
e(15,15,2,2,(u,v)=>u+v<0?'#d8d8e4':'#5a5a6a')}
else if(id=='statue'){const P=['#f0f0f8','#b8b8cc','#74748a'];
r(3,34,18,8,(i,j,w,h)=>j==0?P[0]:i==0?P[0]:i==w-1||j==h-1?P[2]:P[1]);r(1,40,22,2,(i,j)=>j?P[2]:P[1]);r(5,36,14,1,P[2]);
// 石のりゅう(すわって上を向く)
e(12,26,6.5,8,sh(P));e(9,30,3,4,sh(P));e(16,31,3,3,sh(P));e(13,14,5,5,sh(P));r(14,9,6,4,(i,j)=>j==0?P[0]:j==3?P[2]:P[1]);r(18,11,3,2,P[2]);
ln(9,10,7,3,P[1]);ln(10,10,8,4,P[0]);ln(15,9,17,2,P[1]);ln(16,9,18,3,P[2]);p(15,12,'#3a3a4a');
for(let k=0;k<5;k++)p(5-k*.4,26-k*2,P[1]);e(4,20,3.5,5,(u,v)=>u+v<0?P[0]:P[2]);ln(18,30,21,34,P[2]);r(10,26,1,6,P[2]);tw(20,6)}
else if(id=='flag'){r(2,4,2,37,i=>i?'#8a8a9a':'#e8e8f0');e(3,3,2,2,(u,v)=>u+v<0?'#fff4b8':'#c8961e');r(0,40,6,2,(i,j)=>j?'#4a4a5a':'#8a8a9a')}
else if(id=='flag_f'){const Fc=['#7ac8ff','#2a78e8','#1a4aa8'];
for(let i=4;i<21;i++){const o=Math.round(Math.sin(i*.45)*1.2);for(let j=0;j<12;j++){const y=6+j+o;p(i,y,j==0?Fc[0]:j==11?Fc[2]:(i>10&&i<15&&j>3&&j<8)?'#ffe24a':Fc[1])}}p(12,9+Math.round(Math.sin(12*.45)*1.2),'#fff4b8')}
else if(id=='fire'){for(let k=0;k<3;k++){const y=18+k%2;ln(3,y-k,20,y+1-k*.3,WD[1]);ln(3,y-k+1,20,y+2-k*.3,WD[2])}
r(4,19,16,2,(i,j)=>(i%5==0)?'#4a2a10':j?WD[2]:WD[1]);[[2,20],[6,21],[11,21],[16,21],[20,20]].forEach(([x,y])=>e(x+.5,y,1.6,1,sh(ST)))}
else if(id=='fire_f'){noOL=0;const F=['#fff8c0','#ffd23a','#ff8a1a','#e83a1a'];
for(let j=0;j<16;j++){const hw=j<4?j*.9:Math.max(0,5-(j-4)*.35)*(1+.2*Math.sin(j)),cy=18-j;for(let i=Math.floor(12-hw);i<12+hw;i++){const d=Math.abs(i+.5-12)/Math.max(.5,hw);p(i,cy,d<.35&&j<9?F[0]:d<.65?F[1]:d<.9?F[2]:F[3])}}
ln(7,10,6,6,F[2]);ln(17,11,18,7,F[2]);p(6,5,F[1]);p(18,6,F[1]);p(12,2,F[2]);p(10,0,F[1],L);p(15,1,F[2],L)}
else if(id=='bench'){const P=['#e8a868','#b06a30','#6a3e18'];
r(1,2,32,3,(i,j)=>j==0?P[0]:j==2?P[2]:P[1]);r(1,6,32,3,(i,j)=>j==0?P[0]:j==2?P[2]:P[1]);r(0,10,34,3,(i,j)=>j==0?P[0]:j==2?P[2]:P[1]);
[[3,2],[29,2]].forEach(([x])=>r(x,0,2,10,i=>i?'#3a3a4a':'#6a6a7a'));[[2],[29]].forEach(([x])=>r(x,13,3,5,i=>i==0?'#6a6a7a':'#3a3a4a'))}
// ---- 手前(小さい飾り) ----
else if(id=='bed'){r(0,7,30,7,(i,j,w,h)=>j==0?'#e8a868':i==0?'#c07a40':i==w-1||j==h-1?'#5a3418':(i+j)%4==0?'#7a4a20':'#a0642a');e(15,7,14,3.5,(u,v)=>v>.2?0:'#5a3a1a');
const cs=[['#ffb0c8','#ff5a8a','#a8184a'],['#fff4a0','#ffd23a','#a07818'],['#e0c8ff','#a86aff','#5a28b0'],['#ffffff','#e8ecf4','#9aa4b8']];
[[4,4],[9,2],[14,4],[19,2],[24,4],[7,6],[12,6],[17,6],[22,6],[26,6]].forEach(([x,y],k)=>{const P=cs[k%4];e(x+.5,y+.5,1.8,1.8,sh(P,.4,.4));p(x,y,'#ffe24a')});
[[3,7],[11,7],[20,7],[27,7]].forEach(([x,y])=>{p(x,y,GR[1]);p(x+1,y-1,GR[0])})}
else if(id=='flower'){r(5,7,2,11,i=>i?GR[2]:GR[1]);e(3.5,12,3,1.5,sh(GR,.3,.3));e(8.5,14,3,1.5,sh(GR,.3,.3));
const P=['#ffd0e0','#ff6a9a','#b8205a'];[[6,2.5],[2.5,6],[9.5,6],[6,9.5],[3.5,3.5],[8.5,3.5],[3.5,8.5],[8.5,8.5]].forEach(([x,y])=>e(x,y,2.2,2.2,sh(P,.4,.4)));e(6,6,2,2,(u,v)=>u+v<0?'#fff4a0':'#e8a010');p(5,5,'#ffffff')}
else if(id=='kino'){r(5,8,6,7,(i,j)=>i==0?'#fffaf0':i>=4?'#c8b898':'#f0e4c8');e(8,8,7.5,7,(u,v)=>v>.08?0:u+v<-.75?'#ffb0a0':u+v>.25?'#a81818':'#e83228');
[[4,5],[8,2],[11,5],[6,7],[10,7],[13,7]].forEach(([x,y])=>{p(x,y,'#ffffff');p(x+1,y,'#ffffff');p(x,y-1,'#ffffff')});r(1,8,14,1,'#8a1010');e(13,13,2.2,2,(u,v)=>v>.1?0:'#e83228');r(12,13,2,2,'#f0e4c8')}
else if(id=='rock'){e(8,7,7.5,5,sh(ST,.5,.4));e(14,9,3.6,3,sh(['#d4d4e0','#9a9aac','#5a5a6c'],.4,.3));[[6,6],[9,8],[11,5]].forEach(([x,y])=>p(x,y,'#5a5a6c'));p(5,4,'#ffffff');p(6,3,'#ffffff');r(1,11,17,1,GR[2]);[[2,10],[15,10]].forEach(([x,y])=>p(x,y,GR[1]))}
// ---- おもちゃ ----
else if(id=='ball'){e(8,8.5,7,7,(u,v)=>{const s=Math.floor((Math.atan2(v,u)+Math.PI)/(Math.PI/3))%2,c=s?['#ffb0b0','#ff3a4a','#a01828']:['#ffffff','#f0f0f8','#a8a8bc'];return u+v<-.7?c[0]:u+v>.5?c[2]:c[1]});e(8,8.5,1.8,1.8,'#ffe24a');p(4,4,'#ffffff');p(5,4,'#ffffff')}
else if(id=='tsumiki'){const bx=(x,y,w,h,P,mk)=>{r(x,y,w,h,(i,j)=>i==0||j==0?P[0]:i==w-1||j==h-1?P[2]:P[1]);if(mk)mk(x,y)};
bx(1,9,7,7,['#ffb0a0','#e83a3a','#9a1a20'],(x,y)=>r(x+2,y+2,3,3,'#ffffff'));bx(9,9,7,7,['#b0d8ff','#3a88e8','#1a4a98'],(x,y)=>{p(x+3,y+2,'#fff');r(x+2,y+3,3,1,'#fff');p(x+3,y+4,'#fff')});
for(let j=0;j<7;j++){const hw=j*.55+.5;for(let i=Math.floor(9-hw);i<9+hw;i++)p(i,j+2,(i+.5-9)<-hw*.4?'#fff4a0':(i+.5-9)>hw*.4?'#a07818':'#ffd23a')}}
else if(id=='nui'){const P=['#f0c890','#c08040','#7a4a20'];e(8,12.5,5.5,5,sh(P));e(8,6.5,5,4.6,sh(P));e(3.6,3,2,2,sh(P,.3,.3));e(12.4,3,2,2,sh(P,.3,.3));p(4,3,'#ffb0b8');p(12,3,'#ffb0b8');
e(8,8,2.2,1.6,'#f8e0c0');p(6,6,'#2a1a10');p(10,6,'#2a1a10');p(8,8,'#2a1a10');e(8,13,3,2.6,'#f8e0c0');r(5,10,6,1,'#e83a5a');p(8,11,'#ffd23a');e(3,13,1.8,2.2,sh(P,.3,.3));e(13,13,1.8,2.2,sh(P,.3,.3))}
else if(id=='taiko'){const R=['#ff8a7a','#d83a2a','#8a1a14'];e(9,4,8,3,(u,v)=>u+v<-.5?'#fffaf0':'#f0e4c8');r(1,4,16,8,(i,j,w)=>j==0||j==7?'#f0c040':i<3?R[0]:i>w-4?R[2]:R[1]);e(9,12,8,3,(u,v)=>v<0?0:R[2]);
for(let i=2;i<16;i+=3){ln(i,5,i+1.5,10,'#fff4b8')}ln(1,0,6,4,WD[1]);e(1,0,1.4,1.4,'#fff4dc');ln(17,0,12,4,WD[1]);e(17,0,1.4,1.4,'#fff4dc')}
else if(id=='bub'){r(2,9,1,8,'#c8a060');e(3,6,3,3,(u,v)=>u*u+v*v>.55?'#ff6a9a':0);p(2,16,'#8a6030')}
else if(id=='bub_b'){noOL=1;[[9,6,3.5],[13,11,2.4],[7,13,1.8],[13,3,1.6]].forEach(([x,y,R])=>e(x,y,R,R,(u,v)=>{const d=u*u+v*v;return d>.5?(u+v<0?'#a8e8ff':'#ff8ad0'):u+v<-.7?'#ffffff':d>.3?'#e8f8ff60':0}));p(8,4,'#ffffff');p(12,10,'#ffffff')}
else if(id=='nawa'){const P=['#ff8ab0','#ff4a8a','#a8185a'];
for(let i=3;i<17;i++){const y=5+Math.round(8*Math.pow(Math.sin((i-3)/13*Math.PI),.6));p(i,y,P[1]);p(i,y+1,P[2])}
const hd=(x)=>{r(x,1,3,6,(i,j)=>j==0?'#fff4a0':i==0?'#ffe24a':i==2?'#a07818':'#ffd23a');p(x+1,7,P[1])};hd(1);hd(16)}
const O=A.slice();if(!noOL)for(let j=0;j<H;j++)for(let i=0;i<W;i++)if(!A[j*W+i]&&((i>0&&A[j*W+i-1])||(i<W-1&&A[j*W+i+1])||(j>0&&A[(j-1)*W+i])||(j<H-1&&A[(j+1)*W+i])))O[j*W+i]=OL;
const c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d');
const hx=v=>{const s=v.slice(1);return[0,2,4,6].map(k=>k<s.length?parseInt(s.slice(k,k+2),16):255)};
for(let q=0;q<W*H;q++)[O[q],L[q]].forEach(v=>{if(!v)return;const[R,G,B,a]=hx(v);x.fillStyle=`rgba(${R},${G},${B},${(a/255).toFixed(3)})`;x.fillRect(q%W,Math.floor(q/W),1,1)});return c.toDataURL()}
window.DECOART={sz:SZ,img:id=>C[id]||(C[id]=draw(id))};
})();
