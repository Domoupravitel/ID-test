// Server-confirmed configuration is separate from manual expense drafts and local acknowledgement.
const recurringExpenseViews_ = new Map();
let recurringRepeatDialog_ = null;
const recurringRepeatExplanations_ = Object.freeze({
    on: Object.freeze({title:'Включване на „Повтори“',text:'Използвайте „Повтори“ за предвидими месечни разходи с постоянна сума.\n\nСлед успешно „Запази“ въведената сума става база за повторението. Самото поставяне на отметката не записва правило и не създава начисление.\n\nПовтарящото се начисление се създава в края на календарния месец. Дотогава можете да промените сумата и да я запазите отново. Използва се последното успешно запазено състояние към момента на начисляването.\n\nАвтоматизацията не представлява правно основание за разхода.'}),
    off: Object.freeze({title:'Изключване на „Повтори“',text:'Премахването на отметката само по себе си не спира повторението. Натиснете „Запази“, за да потвърдите спирането. До успешното записване съществуващото правило остава активно.\n\nАко спирането бъде успешно записано преди начисляването в края на месеца, за този още неначислен месец няма да се създаде повтарящо се начисление. Вече начислените предходни месеци остават непроменени.\n\nПри неуспешно или неясно записване спирането не се показва като потвърдено.'})
});
function recurringExpenseView_() {
    if(!recurringExpenseViews_.has(currentRouteKey))recurringExpenseViews_.set(currentRouteKey,{loaded:false,rows:new Map(),message:'',generation:0});
    return recurringExpenseViews_.get(currentRouteKey);
}
function validRecurringPresentation_(rule) {
    return rule && Object.keys(rule).sort().join(',')==='active,baseAmount,category,effectiveFromPeriod' &&
        chargeLabelsMap.some(c=>c.key===rule.category) && typeof rule.active==='boolean' &&
        (rule.effectiveFromPeriod===null ? rule.active===false && rule.baseAmount===null : /^(0[1-9]|1[0-2])\.(20[0-4][0-9]|2050)$/.test(rule.effectiveFromPeriod)) &&
        (rule.active ? typeof rule.baseAmount==='number' && Number.isFinite(rule.baseAmount) && rule.baseAmount>0 : rule.baseAmount===null);
}
function renderRecurringExpenses_() {
    const box=document.getElementById('recurringExpenseControls');if(!box)return;
    const view=recurringExpenseView_();box.replaceChildren();
    if(!view.loaded){box.textContent=view.message || 'Зареждане на запазените правила…';return;}
    view.rows.forEach((row,category)=>{
        const group=document.createElement('div'),label=document.createElement('label'),amount=document.createElement('input');
        const check=document.createElement('input'),save=document.createElement('button'),status=document.createElement('p');
        const name=chargeLabelsMap.find(c=>c.key===category).name;
        label.textContent=name+' — месечна база';amount.type='text';amount.inputMode='decimal';amount.className='admin-input';
        amount.id='recurringBase_'+category;label.htmlFor=amount.id;amount.value=row.amount;amount.placeholder='Положителна сума за повторение';
        amount.disabled=!!row.pending || row.inFlight;amount.oninput=()=>{row.amount=amount.value;};
        check.type='checkbox';check.id='recurringRepeat_'+category;check.checked=row.localActive;check.disabled=!!row.pending || row.inFlight;
        check.onchange=()=>requestRecurringRepeatChange_(category,check);
        const checkLabel=document.createElement('label');checkLabel.htmlFor=check.id;checkLabel.textContent='Повтори';
        save.type='button';save.className='admin-btn';save.textContent=row.inFlight ? 'Записване…' : row.pending ? 'Повтори същата промяна' : 'Запази';
        save.disabled=row.inFlight;save.onclick=()=>saveRecurringExpense_(category);
        status.textContent=(row.committed.active ? 'Повтаря се ('+row.committed.baseAmount.toFixed(2)+' EUR)' : 'Повторението не е активно.')+
            (row.message ? ' '+row.message : '');
        group.append(label,amount,check,checkLabel,save,status);
        if(row.conflict){const reload=document.createElement('button');reload.type='button';reload.textContent='Зареди текущото правило';reload.onclick=()=>loadRecurringExpenseState_(category);group.append(reload);}
        box.append(group);
    });
}
function resetRecurringExpenseView_() {
    cancelRecurringRepeatDialog();renderRecurringExpenses_();
}
function requestRecurringRepeatChange_(category, checkbox) {
    const row=recurringExpenseView_().rows.get(category);if(!row)return;
    const desired=checkbox.checked;checkbox.checked=row.localActive;
    if(row.pending || row.inFlight || desired===row.localActive)return;
    cancelRecurringRepeatDialog();
    recurringRepeatDialog_={row,category,desired,context:captureFinancialOperationContext()};
    const copy=desired ? recurringRepeatExplanations_.on : recurringRepeatExplanations_.off;
    document.getElementById('recurringRepeatTitle').textContent=copy.title;
    document.getElementById('recurringRepeatExplanation').textContent=copy.text;
    document.getElementById('recurringRepeatDialog').showModal();
}
function acknowledgeRecurringRepeatDialog() {
    const pending=recurringRepeatDialog_;recurringRepeatDialog_=null;
    document.getElementById('recurringRepeatDialog').close();
    if(!pending || !isFinancialOperationContextCurrent(pending.context) || pending.row.pending || pending.row.inFlight)return;
    pending.row.localActive=pending.desired;pending.row.message='Незапазена промяна. Натиснете „Запази“.';
    renderRecurringExpenses_();
}
function cancelRecurringRepeatDialog() {
    recurringRepeatDialog_=null;
    const dialog=document.getElementById('recurringRepeatDialog');if(dialog && dialog.open)dialog.close();
}
async function loadRecurringExpenseState_(discardConflictCategory) {
    const context=captureFinancialOperationContext(),view=recurringExpenseView_(),generation=++view.generation;
    const isCurrent=()=>isFinancialOperationContextCurrent(context) && generation===view.generation;
    try {
        const response=await apiCall('getRecurringExpensesV1',{routeKey:context.routeKey,pin:getStoredPin()},context);
        if(!isCurrent())return;
        if(!response || response.success!==true || !Array.isArray(response.rules) || !response.rules.every(validRecurringPresentation_) ||
            new Set(response.rules.map(r=>r.category)).size!==response.rules.length)throw Error('Invalid recurring read');
        response.rules.forEach(rule=>{
            let row=view.rows.get(rule.category);
            if(!row){row={committed:rule,localActive:rule.active,amount:'',pending:null,inFlight:false,message:'',conflict:false};view.rows.set(rule.category,row);}
            else {row.committed=rule;
                if(discardConflictCategory===rule.category && row.conflict){row.pending=null;row.localActive=rule.active;row.amount='';row.conflict=false;row.message='Заредено е текущото запазено правило.';}}
        });
        view.loaded=true;renderRecurringExpenses_();
    } catch(error) {if(isCurrent()){view.message='Правилата не могат да бъдат потвърдени. Опитайте да отворите панела отново.';renderRecurringExpenses_();}}
}
async function saveRecurringExpense_(category) {
    const view=recurringExpenseView_(),row=view.rows.get(category);if(!row || row.inFlight)return;
    if(!row.pending){
        const period=document.getElementById('chargesPeriod').value;
        if(!/^(0[1-9]|1[0-2])\.(20[0-4][0-9]|2050)$/.test(period)){row.message='Изберете валиден период.';renderRecurringExpenses_();return;}
        const text=row.amount.trim(),amount=Number(text);
        if(row.localActive && (!/^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text) || !Number.isFinite(amount) || amount<=0)){
            row.message='За „Повтори“ въведете положителна сума. Нула и отрицателни суми не създават правило.';renderRecurringExpenses_();return;}
        if(!row.localActive && !row.committed.active){row.message='Няма активно правило за спиране.';renderRecurringExpenses_();return;}
        try {
            const request=Object.freeze({contractVersion:1,changeRequestId:newManualExpenseRequestId_(),category,
                effectiveFromPeriod:period,active:row.localActive,baseAmount:row.localActive ? amount : null});
            row.pending=Object.freeze({request,raw:JSON.stringify(request)});
        } catch(error){row.message='Не може да се създаде защитена идентичност на промяната.';renderRecurringExpenses_();return;}
    }
    const context=captureFinancialOperationContext(),pending=row.pending;row.inFlight=true;renderRecurringExpenses_();
    let response;try{response=await apiCall('saveRecurringExpenseV1',{routeKey:context.routeKey,pin:getStoredPin(),request:pending.raw},context);}catch(error){}
    row.inFlight=false;
    const expected=pending.request;
    if(response && response.success===true && response.changeRequestId===expected.changeRequestId && validRecurringPresentation_(response.rule) &&
        ['category','active','baseAmount','effectiveFromPeriod'].every(k=>Object.is(response.rule[k],expected[k]))){
        // A confirmed Save supersedes every GET begun before this acknowledgement.
        ++view.generation;
        row.committed=response.rule;row.localActive=response.rule.active;row.amount='';row.pending=null;row.conflict=false;row.message='Правилото е запазено.';
    } else {
        row.conflict=!!response && response.error==='RECURRING_CONFLICT';
        row.message=row.conflict ? 'Промяната е в конфликт. Заредете текущото правило преди нова промяна.' :
            'Резултатът от записа е непотвърден. Запазеното правило не е потвърдено като променено. Повторете същата промяна; не презареждайте страницата.';
    }
    if(isFinancialOperationContextCurrent(context))renderRecurringExpenses_();
}
