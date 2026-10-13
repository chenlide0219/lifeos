async (page) => {
  const checks=[];
  const assert=(ok,name)=>{if(!ok)throw new Error(name);checks.push(name)};
  await page.setViewportSize({width:390,height:844});
  await page.goto('http://127.0.0.1:5178/settings');
  await page.getByRole('button',{name:'深色',exact:true}).click();
  assert(await page.locator('html').evaluate(el=>el.classList.contains('dark')),'Settings enables dark theme');
  assert(await page.getByRole('button',{name:'切换主题，当前深色模式'}).isVisible(),'Header theme is synchronized');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    for(const route of ['/','/calendar','/todo','/events','/subscriptions','/analytics','/settings']){
      await page.goto('http://127.0.0.1:5178'+route);
      await page.locator('h1').waitFor();
      await page.waitForLoadState('networkidle');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth),'Dark layout '+route+' '+width);
      await page.screenshot({path:'output/playwright/'+(route==='/'?'dashboard':route.slice(1))+'-dark-'+width+'.png',fullPage:true});
    }
  }
  await page.getByRole('button',{name:'浅色',exact:true}).click();
  assert(await page.getByRole('button',{name:'切换主题，当前浅色模式'}).isVisible(),'Light preference synchronized');
  await page.goto('http://127.0.0.1:5178/todo');
  await page.getByRole('button',{name:'新增',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.waitFor();
  await page.getByLabel('标题',{exact:true}).fill('UI 回归测试');
  await page.getByRole('button',{name:'创建',exact:true}).focus();
  await page.keyboard.press('Tab');
  assert(await dialog.evaluate(el=>el.contains(document.activeElement)),'Dialog focus wraps forward');
  await page.keyboard.press('Shift+Tab');
  assert(await dialog.evaluate(el=>el.contains(document.activeElement)),'Dialog focus wraps backward');
  assert(await page.evaluate(()=>document.body.style.overflow==='hidden'),'Dialog locks background scroll');
  await page.screenshot({path:'output/playwright/task-dialog-mobile.png',fullPage:true});
  await page.keyboard.press('Escape');
  assert(await dialog.count()===0,'Escape closes quick add');
  assert(await page.getByRole('button',{name:'新增',exact:true}).evaluate(el=>el===document.activeElement),'Dialog restores focus');
  await page.getByRole('button',{name:/已完成/}).click();
  await page.getByText('还没有完成的待办',{exact:true}).waitFor();
  checks.push('Todo empty state');
  await page.goto('http://127.0.0.1:5178/subscriptions');
  await page.getByRole('button',{name:'新增订阅',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await page.screenshot({path:'output/playwright/subscription-dialog-mobile.png',fullPage:true});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'导入 CSV',exact:true}).click();
  await page.getByRole('dialog',{name:'导入 CSV'}).waitFor();
  await page.keyboard.press('Escape');
  assert(await page.getByRole('dialog').count()===0,'CSV and subscription dialogs close with Escape');
  await page.getByRole('button',{name:'语音录入',exact:true}).click();
  await page.getByRole('dialog',{name:'语音录入'}).waitFor();
  await page.getByText('语音识别当前不可用，你可以直接在下方输入文字，效果相同。').waitFor();
  await page.screenshot({path:'output/playwright/voice-dialog-mobile.png',fullPage:true});
  await page.keyboard.press('Escape');
  checks.push('Voice fallback entry retained');
  await page.goto('http://127.0.0.1:5178/calendar');
  for(const name of ['周','日','月']){await page.getByRole('button',{name,exact:true}).click();assert(await page.getByRole('button',{name,exact:true}).getAttribute('aria-pressed')==='true','Calendar '+name+' view');}
  await page.getByRole('button',{name:'事件',exact:true}).click();
  assert(await page.getByRole('button',{name:'事件',exact:true}).getAttribute('aria-pressed')==='false','Calendar type filter');
  return {checks};
}
