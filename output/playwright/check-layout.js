async (page) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const results = [];
  for (const width of [1440, 834, 390, 360]) {
    await page.setViewportSize({width,height:900});
    for (const route of ['/', '/calendar','/todo','/events','/subscriptions','/analytics','/settings']) {
      await page.goto('http://127.0.0.1:5178'+route);
      await page.locator('h1').waitFor();
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth, offenders:Array.from(document.querySelectorAll('main *')).filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,6).map(el=>el.tagName+'.'+el.className)}));
      results.push({route,width,...overflow});
      if(width===1440 || width===390) await page.screenshot({path:'output/playwright/'+(route==='/'?'dashboard':route.slice(1))+'-'+(width===1440?'desktop':'mobile')+'.png',fullPage:true});
    }
  }
  await page.evaluate(result => console.log('QA_LAYOUT '+JSON.stringify(result)), {results,errors});
}
