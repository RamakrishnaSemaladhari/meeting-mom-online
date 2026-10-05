(function(){
  const BATCH_SECONDS=600;
  let originalLoadMeetingResults=null;
  let batchPollTimer=null;

  function escapeHtml(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

  function ensureBatchUI(){
    const card=document.getElementById('processingCard');
    if(card&&!document.getElementById('batchProgressLine')){
      const el=document.createElement('div');
      el.id='batchProgressLine'; el.className='eta-box'; el.style.marginTop='8px';
      el.innerHTML='<b>Long meeting:</b> preparing automatic 10-minute batches…';
      card.insertBefore(el,card.querySelector('.processing-note'));
    }
    const results=document.getElementById('resultsCard');
    if(results&&!document.getElementById('sourceDocumentsSection')){
      const sec=document.createElement('div');
      sec.id='sourceDocumentsSection'; sec.className='results-section';
      sec.innerHTML='<label>Source Documents</label><div id="sourceDocumentsList"></div>';
      const anchor=document.getElementById('documentList');
      if(anchor&&anchor.parentElement) anchor.parentElement.parentElement.insertBefore(sec,anchor.parentElement);
    }
  }

  function setBatchUI(data){
    ensureBatchUI();
    const el=document.getElementById('batchProgressLine'); if(!el)return;
    const total=Number(data?.batch_total||0), index=Number(data?.batch_index||0);
    if(total>0){
      const pct=Math.min(100,Math.round(index/total*100));
      el.innerHTML='<b>Long meeting:</b> Batch '+index+' / '+total+' ('+pct+'%)'+(data.message?' — '+escapeHtml(data.message):'');
    }else{
      el.innerHTML='<b>Long meeting:</b> preparing automatic 10-minute batches…';
    }
  }

  async function addSourceDocuments(item){
    if(!item?.meetingFolderId)return;
    try{
      const files=await listDriveFiles("'"+item.meetingFolderId+"' in parents and trashed = false","files(id,name,mimeType,webViewLink,modifiedTime)");
      const folders={};
      files.filter(x=>x.mimeType==='application/vnd.google-apps.folder').forEach(x=>folders[x.name]=x);
      const transcriptFolder=item.transcript||folders.TRANSCRIPT;
      const translationFolder=item.translation||folders.TRANSLATION;
      const rows=[];
      for(const f of files.filter(x=>x.name==='BATCH_MANIFEST.json')){
        rows.push('<div class="doc-row"><div class="doc-name">'+escapeHtml(f.name)+'</div><div class="doc-actions"><button type="button" class="secondary mini" data-source-id="'+escapeHtml(f.id)+'" data-source-name="'+escapeHtml(f.name)+'">DOWNLOAD</button></div></div>');
      }
      if(transcriptFolder?.id){
        const ts=await listDriveFiles("'"+transcriptFolder.id+"' in parents and trashed = false");
        for(const name of ['Original Transcript - Complete Meeting.txt','Transcript.json']){
          const f=ts.find(x=>x.name===name); if(f) rows.push('<div class="doc-row"><div class="doc-name">'+escapeHtml(f.name)+'</div><div class="doc-actions"><button type="button" class="secondary mini" data-source-id="'+escapeHtml(f.id)+'" data-source-name="'+escapeHtml(f.name)+'">DOWNLOAD</button></div></div>');
        }
      }
      if(translationFolder?.id){
        const ts=await listDriveFiles("'"+translationFolder.id+"' in parents and trashed = false");
        for(const name of ['English Translation - Complete Meeting.txt','Original + English Translation - Complete Meeting.txt','Original + English Translation - Complete Meeting.docx','Translation.json']){
          const f=ts.find(x=>x.name===name); if(f) rows.push('<div class="doc-row"><div class="doc-name">'+escapeHtml(f.name)+'</div><div class="doc-actions"><button type="button" class="secondary mini" data-source-id="'+escapeHtml(f.id)+'" data-source-name="'+escapeHtml(f.name)+'">DOWNLOAD</button></div></div>');
        }
      }
      const box=document.getElementById('sourceDocumentsList');
      if(box){
        box.innerHTML=rows.join('')||'<div class="muted small">Source documents will appear when processing is complete.</div>';
        box.querySelectorAll('[data-source-id]').forEach(b=>b.onclick=()=>downloadDriveFile(b.dataset.sourceId,b.dataset.sourceName));
      }
    }catch(e){console.warn('Source document listing failed',e);}
  }

  async function readBatchStatus(item){
    if(!item?.meetingFolderId)return null;
    try{
      const files=await listDriveFiles("'"+item.meetingFolderId+"' in parents and name = 'PROCESSING_STATUS.json' and trashed = false","files(id,name,modifiedTime)");
      let root=null;
      if(files.length){
        const r=await driveRequest('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(files[0].id)+'?alt=media');
        root=await r.json();
      }
      // During parallel processing the root status intentionally remains stable so
      // concurrent workers cannot overwrite one another. Aggregate per-batch status
      // files to give the user a live progress view.
      const folders=await listDriveFiles("'"+item.meetingFolderId+"' in parents and name = 'BATCHES' and trashed = false","files(id,name,mimeType)");
      if(folders.length){
        const batchFiles=await listDriveFiles("'"+folders[0].id+"' in parents and name contains 'BATCH_STATUS_' and trashed = false","files(id,name)");
        if(batchFiles.length){
          let done=0, active=0, failed=0, total=Number(root?.batch_total||batchFiles.length);
          let latestMessage='';
          for(const bf of batchFiles){
            try{
              const rr=await driveRequest('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(bf.id)+'?alt=media');
              const d=await rr.json();
              if(String(d.status||'').toUpperCase()==='COMPLETED') done++;
              else if(String(d.status||'').toUpperCase()==='FAILED') failed++;
              else active++;
              if(d.message) latestMessage=d.message;
              total=Math.max(total,Number(d.batch_total||0));
            }catch(_){}
          }
          if(total>0 && (done||active||failed)){
            return {
              ...(root||{}),
              status: failed ? 'FAILED' : done===total ? 'COMPLETED' : 'PROCESSING',
              stage: failed ? 'FAILED' : done===total ? 'COMPLETED' : 'TRANSCRIBING',
              progress_percent: Math.min(94, Math.round(done/total*90)+5),
              batch_index: done,
              batch_total: total,
              message: failed ? 'One or more parallel batches failed.' :
                done===total ? 'All parallel batches complete; final synthesis is starting.' :
                (latestMessage || ('Parallel batches: '+done+' / '+total+' complete'))
            };
          }
        }
      }
      return root;
    }catch(e){return null;}
  }

  async function pollBatchStatus(item){
    if(!item?.id)return;
    const loop=async()=>{
      const data=await readBatchStatus(item);
      if(data){
        setBatchUI(data);
        if(data.status==='COMPLETED'||data.stage==='COMPLETED'){
          clearTimeout(batchPollTimer); await addSourceDocuments(item); return;
        }
        if(data.status==='FAILED'||data.stage==='FAILED'){clearTimeout(batchPollTimer); return;}
      }
      batchPollTimer=setTimeout(loop,5000);
    };
    loop();
  }

  function patchResults(){
    if(typeof window.loadMeetingResults==='function'&&!originalLoadMeetingResults){
      originalLoadMeetingResults=window.loadMeetingResults;
      window.loadMeetingResults=async function(item){
        await originalLoadMeetingResults(item);
        await addSourceDocuments(item);
      };
    }
  }

  function install(){
    ensureBatchUI(); patchResults();
    const oldNotify=window.notifyProcessingStarted;
    if(typeof oldNotify==='function'&&!window.__batchNotifyPatched){
      window.__batchNotifyPatched=true;
      window.notifyProcessingStarted=async function(snapshot,options){
        const result=await oldNotify(snapshot,options);
        pollBatchStatus({id:snapshot.meeting.id,meetingFolderId:snapshot.meeting.id});
        return result;
      };
    }
    setTimeout(install,1000);
  }
  document.addEventListener('DOMContentLoaded',install);
})();