async(page)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1440,height:1000});
 await page.screenshot({path:'output/playwright/concepts-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'手机竖屏',exact:true}).click();
 await page.screenshot({path:'output/playwright/concepts-phones.png',fullPage:true});
 const phoneOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 await page.getByRole('button',{name:'切换浅 / 深配色',exact:true}).click();
 await page.screenshot({path:'output/playwright/concepts-alternate.png',fullPage:true});
 await page.getByRole('button',{name:'02 精密',exact:true}).click();
 const onlyPrecision=await page.locator('.direction:visible').count()===1;
 await page.getByRole('button',{name:'全部对比',exact:true}).click();
 await page.getByRole('button',{name:'切换浅 / 深配色',exact:true}).click();
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'output/playwright/concepts-mobile-browser.png',fullPage:true});
 const narrowOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'桌面',exact:true}).click();
 return {errors,phoneOverflow,narrowOverflow,onlyPrecision};
}
