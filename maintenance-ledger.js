// Immutable request retained across explicit retry/reload. Storage is never financial authority.
const maintenancePending_ = new Map();
function maintenancePendingKey_(route) { return 'maintenanceDistributionV1_'+route; }
function maintenancePendingFor_(route) {
    if(!maintenancePending_.has(route)){
        const raw=sessionStorage.getItem(maintenancePendingKey_(route));
        if(raw){const request=JSON.parse(raw);if(!request||request.source!=='maintenance'||typeof request.requestId!=='string')throw Error('Невалидна запазена заявка.');
            maintenancePending_.set(route,{raw,request,inFlight:false});}
    }
    return maintenancePending_.get(route)||null;
}
function maintenanceRenderPending_() {
    const pending=maintenancePendingFor_(currentRouteKey);
    if(pending){
        const r=pending.request;for(const [id,value]of [['v2DistPeriod',r.period],['v2DistCategory','maintenance'],['v2DistAmount',(r.amountCents/100).toFixed(2)],['v2DistNote',r.note]]){const n=document.getElementById(id);if(n)n.value=value;}
        document.querySelectorAll('#v2DistApts input').forEach(n=>n.checked=r.apartments.includes(normalizeFinancialApartmentId_(n.value)));
        document.querySelectorAll('input[name="v2DistType"]').forEach(n=>n.checked=n.value===r.type);
    }
    for(const id of ['v2DistPeriod','v2DistCategory','v2DistAmount','v2DistNote']){const n=document.getElementById(id);if(n)n.disabled=!!pending;}
    document.querySelectorAll('#v2DistApts input, input[name="v2DistType"]').forEach(n=>n.disabled=!!pending);
    const button=document.getElementById('v2SubmitDistBtn');if(button){button.disabled=!!pending?.inFlight;button.textContent=pending?'Продължи същото разпределение':'🧮 Разпредели сумата';}
}
function maintenanceDisplay_(result,target) {
    if(!result||result.success!==true||result.source!=='maintenance'||!['openingCents','collectedCents','usedCents','availableCents'].every(k=>Number.isSafeInteger(result[k])&&result[k]>=0)||
        result.availableCents!==result.openingCents+result.collectedCents-result.usedCents)throw Error('Непотвърдена наличност.');
    if(target)target.textContent='Събрани: '+(result.collectedCents/100).toFixed(2)+' EUR · Използвани / Разпределени: '+(result.usedCents/100).toFixed(2)+
        ' EUR · Налични: '+(result.availableCents/100).toFixed(2)+' EUR'+(result.openingCents?' · Начално салдо: '+(result.openingCents/100).toFixed(2)+' EUR':'');
}
async function maintenanceReadBalance_(context) {
    const pin=sessionStorage.getItem('adminAuth_'+context.routeKey);if(!pin)throw Error('Нужен е администраторски достъп за потвърждение.');
    const result=await apiCall('getMaintenanceBalanceV1',{routeKey:context.routeKey,pin},context);assertFinancialOperationContextCurrent(context);
    if(result?.error==='MAINTENANCE_OPENING_REQUIRED')throw Error('Началното салдо на източника още не е потвърдено.');
    maintenanceDisplay_(result,null);return result;
}
async function maintenanceRefreshSummary_() {
    const context=captureFinancialOperationContext(),target=document.getElementById('maintenanceSourceSummary');
    if(!target)return;
    target.textContent='Наличността не е потвърдена.';
    try{const result=await maintenanceReadBalance_(context);maintenanceDisplay_(result,target);maintenanceRenderPending_();}
    catch(error){if(isFinancialOperationContextCurrent(context))target.textContent='Поддръжка: наличността не е потвърдена.';}
}
async function maintenanceUpdateAvailable_() {
    if(document.getElementById('v2DistCategory').value!=='maintenance')return false;
    const context=captureFinancialOperationContext(),target=document.getElementById('lbl-v2DistAmount');
    if(target)target.textContent='Сума за разпределяне — наличността се проверява…';
    const balance=document.getElementById('v2DistTypeBalanceLabel'),note=document.getElementById('v2DistCreditNote');
    if(balance)balance.style.display='';if(note)note.style.display='none';
    try{const result=await maintenanceReadBalance_(context);if(document.getElementById('v2DistCategory').value==='maintenance'&&target)target.textContent='Сума за разпределяне (Налични: '+(result.availableCents/100).toFixed(2)+' EUR)';}
    catch(error){if(isFinancialOperationContextCurrent(context)&&document.getElementById('v2DistCategory').value==='maintenance'&&target)target.textContent='Сума за разпределяне (Налични: непотвърдени)';}
    maintenanceRenderPending_();return true;
}
async function submitMaintenanceDistributionIfSelected_() {
    const context=captureFinancialOperationContext();let pending=maintenancePendingFor_(context.routeKey);
    if(!pending&&document.getElementById('v2DistCategory').value!=='maintenance')return false;
    if(pending?.inFlight)return true;
    try{
        if(!pending){
            const text=document.getElementById('v2DistAmount').value;
            if(typeof text!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(text))throw Error('Въведете положителна сума с до два десетични знака.');
            const parts=text.split('.'),amountCents=Number(parts[0])*100+Number((parts[1]||'').padEnd(2,'0'));
            if(!Number.isSafeInteger(amountCents)||amountCents<=0)throw Error('Невалидна сума.');
            const apartments=Array.from(document.querySelectorAll('#v2DistApts input:checked')).map(n=>normalizeFinancialApartmentId_(n.value));
            if(!apartments.length||new Set(apartments).size!==apartments.length)throw Error('Изберете различни апартаменти.');
            const request={contractVersion:1,requestId:newManualExpenseRequestId_(),source:'maintenance',period:document.getElementById('v2DistPeriod').value,
                amountCents,type:document.querySelector('input[name="v2DistType"]:checked')?.value||'cash',apartments,note:document.getElementById('v2DistNote').value};
            const raw=JSON.stringify(request);sessionStorage.setItem(maintenancePendingKey_(context.routeKey),raw);
            pending={raw,request,inFlight:false};maintenancePending_.set(context.routeKey,pending);
        }
        pending.inFlight=true;maintenanceRenderPending_();
        const result=await apiCall('distributeMaintenanceV1',{routeKey:context.routeKey,pin:sessionStorage.getItem('adminAuth_'+context.routeKey),request:pending.raw},context);
        assertFinancialOperationContextCurrent(context);
        if(!result||result.success!==true||!['APPLIED','APPLIED_REPLAY'].includes(result.status)||result.routeKey!==context.routeKey||result.source!=='maintenance'||result.requestId!==pending.request.requestId||result.amountCents!==pending.request.amountCents||typeof result.distributionId!=='string'||!/^[0-9a-f]{64}$/.test(result.distributionId)){
            // BEGIN MAINTENANCE REMEDIATION_MANUAL_REVIEW
            if(result?.error==='MAINTENANCE_PREPARED_AUTHORITY_DRIFT')throw Error('Подготвеното разпределение изисква ръчна проверка. Запазете заявката и не въвеждайте ново разпределение.');
            // END MAINTENANCE REMEDIATION_MANUAL_REVIEW
            if(result?.rejectedBeforeCommit===true&&['MAINTENANCE_INSUFFICIENT','MAINTENANCE_PERIOD','MAINTENANCE_PRECISION','MAINTENANCE_OVERPAYMENT'].includes(result.error)){
                sessionStorage.removeItem(maintenancePendingKey_(context.routeKey));maintenancePending_.delete(context.routeKey);
                if(result.error!=='MAINTENANCE_INSUFFICIENT')throw Error('Няма запис по тази заявка. Проверете текущия период, задълженията и точните центови дялове.');
            }
            throw Error(result?.error==='MAINTENANCE_INSUFFICIENT'?'Недостатъчна наличност. Разпределението не е потвърдено.':'Разпределението не е потвърдено. Продължете само със същата заявка.');
        }
        maintenanceDisplay_(Object.assign({success:true},result.balance),null);
        sessionStorage.removeItem(maintenancePendingKey_(context.routeKey));maintenancePending_.delete(context.routeKey);
        showToast('Разпределението е потвърдено.','success');
        await maintenanceRefreshSummary_();await maintenanceUpdateAvailable_();
        if(typeof loadDistributionsV2==='function')await loadDistributionsV2(context);
    }catch(error){if(isFinancialOperationContextCurrent(context))showToast(error.message,'error');}
    finally{if(pending)pending.inFlight=false;if(isFinancialOperationContextCurrent(context))maintenanceRenderPending_();}
    return true;
}
