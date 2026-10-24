/* T0.4 target-aware Firestore facade. References remain lazy until their
 * complete path/query/payload ownership can be classified. */
function installTestFirestoreFacade(sdk, session, call) {
    const TEST='702112ТЕСТ1А';
    const SENSITIVE=new Set(['apartments','monthlyReports','buildingCharges','incomesV2','distributionsV2','externalPayers','chargesV2','creditLiabilitiesV2']);
    const isTestId=v=>typeof v==='string'&&(v===TEST||v.startsWith(TEST+'_'));
    const parts=v=>String(v||'').split('/').filter(Boolean);
    const capture=()=>{const s=session();return s&&s.routeKey===TEST?{leaseId:s.leaseId,generation:s.generation,epoch:s.epoch}:null;};
    const sameOwner=o=>{const s=session();return !!o&&s&&s.routeKey===TEST&&s.leaseId===o.leaseId&&Number(s.generation)===Number(o.generation)&&s.epoch===o.epoch;};
    const constraints=new WeakMap();
    const ref=(kind,path,db,owner,filters,scope)=>({__t04:true,kind,path,collection:parts(path)[0]||'',db,id:kind==='document'?parts(path).slice(-1)[0]:null,owner:owner||null,filters:filters||[],routeScope:scope===undefined?null:scope});
    function describe(t){
        if(t&&t.__t04)return t;
        const path=t&&(t.path||(t._key&&t._key.path&&t._key.path.canonicalString&&t._key.path.canonicalString()))||'',p=parts(path);
        const kind=t&&t.type==='query'?'query':t&&t.type==='collection'?'collection':t&&t.type==='document'?'document':p.length?(p.length%2?'collection':'document'):'unknown';
        return ref(kind,path,t&&t.firestore,null,[],null);
    }
    function filterRoute(filters){let route=null;for(const a of filters||[]){if(!a||a.length!==3||a[1]!=='==')continue;if(a[0]==='routeKey'||a[0]==='buildingId'){if(route!==null&&route!==a[2])return{ambiguous:true,route:null};route=a[2];}}return{route,ambiguous:false};}
    function classify(input,data){
        const t=describe(input),r=t.kind==='query'?filterRoute(t.filters):{route:null,ambiguous:false};if(r.ambiguous)return'DENY';
        const test=t.routeScope===TEST||!!t.owner||parts(t.path).some(isTestId)||isTestId(t.id)||!!(data&&(data.routeKey===TEST||data.buildingId===TEST))||r.route===TEST;
        const normal=(t.routeScope!==null&&t.routeScope!==TEST)||!!(data&&((data.routeKey!==undefined&&data.routeKey!==TEST)||(data.buildingId!==undefined&&data.buildingId!==TEST)))||(r.route!==null&&r.route!==TEST);
        if(test&&normal)return'DENY';if(test)return'TEST';if(normal)return'NORMAL';if(SENSITIVE.has(parts(t.path)[0]))return'DENY';return'NORMAL';
    }
    function rawCollection(t){const p=parts(t.path);if(p.length===1)return sdk.collection(t.db,t.path);return sdk.collection(sdk.doc(t.db,...p.slice(0,-1)),p[p.length-1]);}
    function rawTarget(input){const t=describe(input),p=parts(t.path);if(t.kind==='document')return sdk.doc(t.db,...p);if(t.kind==='query')return sdk.query(rawCollection(t),...t.filters.map(a=>sdk.where(...a)));return rawCollection(t);}
    function stale(){const e=Error('Stale TEST session response');e.staleTestSession=true;return e;}
    async function request(action,input,params){const t=describe(input),o=t.owner||capture();if(!o||!o.leaseId||!o.generation||o.epoch===undefined||!sameOwner(o))throw stale();let result;try{result=await call(action,{...params,...o,collection:parts(t.path)[0]});}catch(e){if(!sameOwner(o))throw stale();throw e;}if(!sameOwner(o))throw stale();if(!result||!result.success)throw Error('TEST request rejected: '+(result&&(result.failure||result.error)));return result;}
    const wrappedDoc=(d,t)=>({id:d.id,ref:ref('document',t.path+'/'+d.id,t.db,t.owner,[],t.routeScope),exists:()=>typeof d.exists==='function'?d.exists():!!d.data,data:()=>typeof d.data==='function'?d.data():d.data});
    function wrapNormalDoc(s,t){if(!s||!s.ref)return s;return{id:s.id,ref:ref('document',s.ref.path||t.path,t.db,null,[],t.routeScope!==null?t.routeScope:filterRoute(t.filters).route),exists:()=>s.exists(),data:()=>s.data(),metadata:s.metadata};}
    function wrapNormalSet(s,t){if(!s||!Array.isArray(s.docs))return s;const docs=s.docs.map(d=>wrapNormalDoc(d,t));return{...s,docs,forEach:fn=>docs.forEach(fn)};}
    const api={...sdk};
    api.collection=(first,name)=>{if(first&&(first.__t04||first.path)){const base=describe(first);return ref('collection',base.path+'/'+name,base.db,base.owner,[],base.routeScope);}return ref('collection',name,first,capture());};
    api.doc=(...a)=>{if(a[0]&&(a[0].__t04||a[0].path)&&a.length===2){const base=describe(a[0]);return ref('document',base.path+'/'+a[1],base.db,base.owner,[],base.routeScope);}return ref('document',a.slice(1).join('/'),a[0],capture());};
    api.routeDoc=(db,col,id,route)=>ref('document',col+'/'+id,db,capture(),[],route);
    api.where=(...a)=>{const token={};constraints.set(token,a);return token;};
    api.query=(input,...filters)=>{if(!input||(!input.__t04&&!input.path))return sdk.query(input,...filters);if(!input.__t04&&input.type==='query')throw Error('Opaque Firestore query cannot be safely composed');const t=describe(input),next=filters.map(f=>constraints.get(f));if(next.some(v=>!v))throw Error('Opaque Firestore constraint cannot be safely classified');return ref('query',t.path,t.db,t.owner,(t.filters||[]).concat(next),t.routeScope);};
    api.getDoc=async input=>{const t=describe(input),type=classify(t);if(type==='DENY')throw Error('Ambiguous TEST-sensitive document read');if(type==='NORMAL')return wrapNormalDoc(await sdk.getDoc(rawTarget(t)),t);const r=await request('testDocumentRead',t,{id:t.id});return wrappedDoc((r.details.documents||[])[0]||{id:t.id,data:null},t);};
    api.getDocs=async input=>{const t=describe(input),type=classify(t);if(type==='DENY')throw Error('Ambiguous TEST-sensitive query');if(type==='NORMAL')return wrapNormalSet(await sdk.getDocs(rawTarget(t)),t);let after='',docs=[];do{const r=await request('testDocumentRead',t,{filters:JSON.stringify(t.filters),after});docs.push(...r.details.documents.map(d=>wrappedDoc(d,t)));after=r.details.after;}while(after);return{docs,empty:!docs.length,size:docs.length,forEach:fn=>docs.forEach(fn)};};
    for(const[method,mode]of[['addDoc','create'],['updateDoc','update'],['deleteDoc','delete']])api[method]=async(input,data)=>{const t=describe(input),type=classify(t,data);if(type==='DENY')throw Error('Ambiguous TEST-sensitive mutation');if(type==='NORMAL')return sdk[method](rawTarget(t),...(method==='deleteDoc'?[]:[data]));const r=await request('testDocumentMutation',t,{id:t.id||'',mode,data:JSON.stringify(data||{}),pin:(session()||{}).pin});return{id:r.details&&r.details.id};};
    api.setDoc=async(input,...args)=>{const t=describe(input),type=classify(t,args[0]);if(type==='TEST')throw Error('TEST absolute writes disabled; use server delta');if(type==='DENY')throw Error('Ambiguous TEST-sensitive mutation');return sdk.setDoc(rawTarget(t),...args);};
    return api;
}
if(typeof module!=='undefined'&&module.exports)module.exports={installTestFirestoreFacade};
