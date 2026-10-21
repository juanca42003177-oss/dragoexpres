/* DragoExpres — buscador de zonas (autocomplete): mientras el usuario escribe su
   municipio/colonia, se van filtrando las sugerencias en vez de mostrar las 368 de golpe.
   Se monta ENCIMA del select original (que queda oculto), asi todo el resto de la logica
   (validaciones, __otra, guardar zona) sigue funcionando exactamente igual. */
function zonaAuto(selId){
  var sel=document.getElementById(selId); if(!sel||sel.__za)return; sel.__za=1;
  var wrap=document.createElement('div'); wrap.style.position='relative';
  sel.parentNode.insertBefore(wrap,sel); sel.style.display='none'; wrap.appendChild(sel);
  var inp=document.createElement('input'); inp.type='text'; inp.autocomplete='off'; inp.autocapitalize='off';
  inp.placeholder='Escribí tu municipio, pueblo o colonia...';
  inp.style.cssText='width:100%;box-sizing:border-box;border:1.5px solid #ccc;border-radius:10px;padding:10px 12px;font-size:15px;background:#fff;color:#111;outline:none';
  var dd=document.createElement('div');
  dd.style.cssText='display:none;position:absolute;left:0;right:0;top:100%;z-index:99999;background:#fff;border:1px solid #ccc;border-radius:10px;margin-top:4px;max-height:260px;overflow-y:auto;box-shadow:0 10px 24px rgba(0,0,0,.3)';
  function pos(){
    var r=inp.getBoundingClientRect();
    var abajo=window.innerHeight-r.bottom, arriba=r.top;
    if(abajo<200&&arriba>220){
      dd.style.top='auto';dd.style.bottom='100%';dd.style.marginTop='0';dd.style.marginBottom='4px';
      dd.style.maxHeight=Math.max(150,Math.min(260,arriba-16))+'px';
    }else{
      dd.style.top='100%';dd.style.bottom='auto';dd.style.marginTop='4px';dd.style.marginBottom='0';dd.style.maxHeight='260px';
    }
  }
  wrap.appendChild(inp); wrap.appendChild(dd);
  var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')};
  var norm=function(s){return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')};
  var items=function(){
    var out=[],v=(window.ZGT||[]);
    v.forEach(function(g){g.z.forEach(function(z){if(!out.some(function(i){return i.z===z}))out.push({z:z,g:g.g})})});
    (window.ZONAS||[]).forEach(function(a){if(!out.some(function(i){return i.z===a}))out.push({z:a,g:'Zona activa'})});
    return out;
  };
  var activa=function(z){return (window.ZONAS||[]).indexOf(z)>=0};
  var hasOtra=function(){for(var i=0;i<sel.options.length;i++){if(sel.options[i].value==='__otra')return true}return false};
  var libre=function(){return document.getElementById(selId+'-libre')||document.getElementById(selId+'Libre')};
  function buscar(q){q=norm(q);return items().filter(function(i){return norm(i.z).indexOf(q)>=0||norm(i.g).indexOf(q)>=0}).slice(0,10)}
  function dispara(){try{if(typeof sel.onchange==='function')sel.onchange({target:sel,type:'change'})}catch(e){}}
  function elegir(z){
    inp.value=z; dd.style.display='none';
    var hay=false,i,o;
    for(i=0;i<sel.options.length;i++){o=sel.options[i]; if(o.value===z||o.text.split(' — ')[0]===z){sel.value=o.value;hay=true;break}}
    if(!hay&&hasOtra()){
      sel.value='__otra'; var li=libre();
      if(li){li.value=z;li.style.display='block'}
    }
    dispara();
  }
  function pintar(q){
    var res=buscar(q); dd.innerHTML='';
    res.forEach(function(i){
      var r=document.createElement('div');
      r.style.cssText='padding:10px 12px;cursor:pointer;font-size:14.5px;border-bottom:1px solid #eee;color:#111;line-height:1.35';
      r.innerHTML='<b>'+esc(i.z)+'</b> <span style="color:#888">— '+esc(i.g)+'</span>'+(activa(i.z)?' <b style="color:#1a7a2e;white-space:nowrap"><img src="img/dragon-volando.png" alt="" style="width:18px;height:16px;object-fit:contain;vertical-align:-3px"> pilotos</b>':'');
      r.onmousedown=function(e){e.preventDefault();elegir(i.z)};
      dd.appendChild(r);
    });
    if(!res.length||!res.some(function(i){return i.z.toLowerCase()===q.toLowerCase()})){
      if(hasOtra()){
        var f=document.createElement('div');
        f.style.cssText='padding:10px 12px;cursor:pointer;font-size:14px;color:#1a5cb0;border-bottom:1px solid #eee';
        f.innerHTML='➕ Usar <b>“'+esc(q)+'”</b> como mi zona';
        f.onmousedown=function(e){e.preventDefault();elegir(q)};
        dd.appendChild(f);
      } else if(!res.length){
        var n=document.createElement('div');
        n.style.cssText='padding:10px 12px;font-size:13.5px;color:#999';
        n.textContent='Seguí escribiendo o probá con el nombre del departamento...';
        dd.appendChild(n);
      }
    }
    pos();
    dd.style.display='block';
  }
  inp.addEventListener('input',function(){
    var q=inp.value.trim();
    if(q.length<2){dd.style.display='none';return}
    pintar(q);
  });
  inp.addEventListener('focus',function(){
    var q=inp.value.trim();
    try{setTimeout(function(){pos();inp.scrollIntoView({block:'center',behavior:'smooth'})},250)}catch(e){}
    if(q.length>=2)pintar(q);
  });
  document.addEventListener('click',function(e){if(!wrap.contains(e.target))dd.style.display='none'});
  /* sync: si otra parte del codigo setea el select (restaurar zona guardada), el buscador la refleja */
  setInterval(function(){
    if(dd.style.display==='block')pos();
    if(document.activeElement===inp)return;
    var cur=sel.value;
    if(cur==='__otra'){var li=libre(); if(li&&li.style.display!=='none'&&li.value&&inp.value!==li.value)inp.value=li.value;}
    else if(cur&&cur!==inp.value){
      for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===cur){inp.value=sel.options[i].text.split(' — ')[0];return}}
    }
  },400);
}
(function(){
  if(window.ZONA_AUTO_IDS&&document.readyState!=='loading'){window.ZONA_AUTO_IDS.forEach(zonaAuto)}
  else{window.addEventListener('DOMContentLoaded',function(){(window.ZONA_AUTO_IDS||[]).forEach(zonaAuto)})}
})();
