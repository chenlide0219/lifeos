async (page) => {
  await page.unrouteAll();
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace('/api','');
    const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
    const task = {id:'task-demo',title:'整理本周计划，留出阅读和运动的时间',dueDate:today,dueTime:'18:00',status:'todo',note:'先完成最重要的一件事',source:'manual'};
    const tasks = [task,{...task,id:'task-2',title:'预约年度体检',dueTime:null,note:null},{...task,id:'task-3',title:'读完《置身事内》第三章',dueTime:'21:00',note:'阅读笔记'}];
    const event = {id:'event-demo',title:'产品设计讨论',startAt:today+'T06:00:00Z',endAt:today+'T07:00:00Z',location:'线上会议',note:'讨论本周重点',status:'active'};
    const sub = {id:'sub-demo',name:'iCloud+',price:'21.00',currency:'CNY',billingPeriod:'monthly',anchorDate:today,nextBillingDate:today,status:'active',autoRenew:true,monthlyEquivalent:'21.00',reminderEnabled:false};
    const subs = [sub,{...sub,id:'sub-2',name:'Notion Plus',price:'10.00',currency:'USD',monthlyEquivalent:'10.00'},{...sub,id:'sub-3',name:'网易云音乐',price:'18.00',monthlyEquivalent:'18.00'}];
    const bills = subs.map((s,i)=>({id:'bill-'+i,subscriptionId:s.id,subscriptionName:s.name,plannedDate:today,amount:s.price,currency:s.currency,status:'expected'}));
    const summary = {expected:{monthlyByCurrency:{CNY:39,USD:10},monthlyTotalNote:'按当前周期折算，与实付不混算'},actual:[{currency:'CNY',gross:'234.00',refunds:'0.00',net:'234.00',count:6}],upcoming:subs.map(s=>({id:s.id,name:s.name,date:today,amount:s.price,currency:s.currency,autoRenew:true})),subscriptions:3,today};
    const payments = [{id:'pay-1',subscriptionName:'iCloud+',amount:'21.00',currency:'CNY',paidAt:today,isRefund:false},{id:'pay-2',subscriptionName:'网易云音乐',amount:'18.00',currency:'CNY',paidAt:today,isRefund:false}];
    const data = {
      '/voice/status':{asr:{configured:false},llm:{configured:true},limits:{maxAudioBytes:1000000}},
      '/auth/me':{user:{id:'demo',username:'Alex',role:'admin'}},
      '/calendar/overview':{today,tasksDueToday:tasks,tasksDueTodayCount:3},
      '/calendar':{items:[{type:'event',id:event.id,title:event.title,date:today,time:'14:00',allDay:false,meta:{}},{type:'task',id:task.id,title:task.title,date:today,time:'18:00',allDay:false,meta:{}},{type:'subscription',id:sub.id,title:'iCloud+ 续费',date:today,allDay:true,meta:{}}]},
      '/tasks':{tasks: u.searchParams.get('view')==='done'?[]:tasks,today},
      '/tasks/counts':{counts:{inbox:3,today:3,upcoming:2,done:8},today},
      '/tasks/task-demo':{task,rule:null},
      '/events':{events:[event,{...event,id:'event-2',title:'傍晚散步 · 公园',startAt:today+'T10:00:00Z',endAt:null,location:'城市公园'}],hasMore:false},
      '/events/event-demo':{event,rule:null},
      '/subscriptions':{subscriptions:subs},
      '/subscriptions/summary':summary,
      '/subscriptions/bills/list':{bills},
      '/subscriptions/payments/list':{payments},
      '/subscriptions/analytics/summary':{expected:[{currency:'CNY',amount:'468.00',count:24},{currency:'USD',amount:'120.00',count:12}],actualNet:summary.actual,byMonth:[{month:'2026-08',currency:'CNY',net:'78.00'},{month:'2026-09',currency:'CNY',net:'117.00'},{month:'2026-10',currency:'CNY',net:'39.00'}],disclaimer:'预计与实付为两套口径，不可相加；不同币种分别展示。'},
      '/subscriptions/sub-demo':{subscription:sub,expectedBills:bills,priceHistory:[],payments},
      '/status':{db:'up',version:'preview',timezone:'Asia/Shanghai',ai:{asr:{configured:true,model:'MiMo'},llm:{configured:true,model:'DeepSeek'}},notifications:[]},
      '/wechat':{bound:false,state:'unbound'},
      '/wechat/assistant':{inboundEnabled:true,modelCallsEnabled:true,draft:null,recent:[],recentReplies:[],inboundCounts:{},outboxCounts:{}},
      '/notifications/jobs':{jobs:[],summary:{},total:0,limit:20,offset:0,providerReady:false}
    };
    if (route.request().method() !== 'GET') return route.fulfill({status:400,json:{message:'预览写操作已拦截'}});
    if (!(p in data)) console.log('UNMOCKED '+p);
    await route.fulfill({status:p in data?200:404,json:data[p]??{message:'未配置预览数据'}});
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('http://127.0.0.1:5178/');
  await page.getByRole('heading',{name:'专注今天'}).waitFor();
  await page.screenshot({path:'output/playwright/dashboard-desktop.png',fullPage:true});
}
