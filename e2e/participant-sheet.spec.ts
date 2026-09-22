import { test, expect, type Page } from '@playwright/test'
import { installYandexMapsMock } from './support.js'

// This suite supplies synthetic identities through page.route, not real API
// cookies. An activated SW can bypass that interception after reload and send
// the synthetic user to the real API (401). Keep this UI fixture deterministic;
// real SW/auth/offline recovery remains covered by its separate existing suites.
test.use({ serviceWorkers: 'block' })
async function prepare(page: Page, navigatorView = false) {
 let attempt: string | null = null; let visitedAt: string | null = null;
 const context = page.context();
 await installYandexMapsMock(context);
 await context.grantPermissions(['geolocation']);
 await context.setGeolocation({latitude:56.86,longitude:53.21,accuracy:8});
 await context.addInitScript(() => {
  const position=()=>({coords:{latitude:56.86,longitude:53.21,accuracy:8,altitude:null,altitudeAccuracy:null,heading:null,speed:0},timestamp:Date.now()});
  Object.defineProperty(navigator.geolocation,'getCurrentPosition',{configurable:true,value:(success: PositionCallback)=>success(position())});
  Object.defineProperty(navigator.geolocation,'watchPosition',{configurable:true,value:(success: PositionCallback)=>{success(position());return setInterval(()=>success(position()),2000)}});
  Object.defineProperty(navigator.geolocation,'clearWatch',{configurable:true,value:(id: number)=>clearInterval(id)});
 });
 await page.setViewportSize({width:390,height:844});
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
 const raidId='55555555-5555-4555-8555-555555555555',teamId='66666666-6666-4666-8666-666666666666',pointId='77777777-7777-4777-8777-777777777777';
 const members=ids.map((id,i)=>({id,displayName:['Павел','Илья','Егор','Лена'][i],avatarUrl:null,state:'active'}));
 const raid={id:raidId,kabandaId:teamId,title:'Лесной маршрут',state:'active',version:3,scheduledAt:null,description:null,organizerUserId:ids[0],navigatorUserId:ids[0],navigatorReady:true,navigatorBlockers:[],navigatorWarnings:[],navigatorLease:null,finalization:null,participants:members,allowedActions:[],routeStatus:{status:'awaiting_lease',acceptedSampleCount:0,missingSequenceCount:0,lastSampleAt:null,lastReceivedAt:null}};
 await page.route('**/api/**',async route=>{
 const path=route.request().url().replace(/^https?:\/\/[^/]+/, '').split('?')[0],now=new Date().toISOString();
 if(path.includes('/route/lease/'))return route.fulfill({status:409,json:{error:{code:'NAVIGATOR_LEASE_HELD',message:'Synthetic device'}}});
 const point={id:pointId,sourcePointId:pointId,name:'Лесное озеро',latitude:56.86012,longitude:53.21,position:0,visitedByMe:Boolean(attempt),visitedByTeam:Boolean(attempt),lastAttemptId:attempt,myLastVisitAttemptId:attempt,lastVisitedAt:visitedAt,repeatAvailableAt:visitedAt ? new Date(Date.parse(visitedAt)+300000).toISOString():null,lastVisitParticipantIds:attempt?ids.slice(0,3):[]};
 const body=path==='/api/me'?{user:{id:navigatorView?ids[0]:ids[1],displayName:navigatorView?'Павел':'Илья',username:'pavel',email:'pavel@example.test',identityKind:'verified',avatarUrl:null}}
 :path==='/api/kabandas'?{kabandas:[{id:teamId,name:'Кабанда',role:'member',avatar:'🐗',coverImage:null,memberCount:4,pointsCollectionId:null}]}
 :path.endsWith('/live')?{raid,serverAt:now,teamVisits:true,positions:ids.slice(0,3).map(userId=>({userId,latitude:56.86,longitude:53.21,accuracyMeters:8,capturedAt:now})),points:[point],claims:[],fallbacks:[],track:{segments:[],pointCount:0,truncated:false,updatedAt:null,serverAt:now}}
 :path.endsWith('/history')?{personalCount:2,visitors:[{userId:ids[0],displayName:'Павел',count:3},{userId:ids[1],displayName:'Илья',count:2}],entries:[],nextOffset:null}
 :path.endsWith('/materials')?{materials:[],nextCursor:null}
 :path.endsWith('/check-ins/nearby')?{policy:{version:'v1',radiusMeters:50,maxAgeSeconds:60,maxAccuracyMeters:50},points:[{...point,pointSnapshotId:pointId,distanceMeters:13,creditedByMe:false,creditedByTeam:false}]}
 :path.endsWith('/presence/me')?{radiusMeters:50,maxAgeSeconds:30,allReady:false,participants:[],serverAt:now}
 :path.endsWith('/media')?{media:[],nextCursor:null}
 :path.endsWith('/raids')?{raids:[raid]}
 :path.includes('templates')?{templates:[],nextCursor:null}
 :path.endsWith('/members')?{members:members.map(m=>({...m,role:'member'}))}
 :path===`/api/raids/${raidId}`?{raid}:{};
 return route.fulfill({json:body});
 });
 await page.goto(`/app?raid=${raidId}`);
 await expect(page.locator(".raid-active-map")).toBeVisible();
 await page.waitForResponse(response => response.url().includes("/live"));
 return { mark: (id: string) => { attempt=id; visitedAt=new Date().toISOString() } };
}

test('participant notification opens read-only attendance and comment without losing sheet chrome', async ({page}) => {
 const controls=await prepare(page);
 await expect(page.locator('.visit-toast')).toHaveCount(0);
 controls.mark('visit-one');
 await expect(page.getByRole('button',{name:'Вас отметили на точке Лесное озеро · Фото и комментарий'})).toBeVisible();
 await page.locator('.visit-toast__open').click();
 const sheet=page.locator('.point-info-sheet');
 await expect(sheet).toBeVisible();
 await expect(sheet.getByText('Вы отмечены',{exact:false})).toBeVisible();
 await expect(sheet.locator('input[type=checkbox]')).toHaveCount(0);
 await expect(sheet.getByRole('button',{name:/Пометить/})).toHaveCount(0);
 await page.screenshot({animations:'disabled',path:'output/playwright/participant-sheet.png'});
 await sheet.getByRole('button',{name:'Комментарий',exact:true}).click();
 await expect(sheet.locator('textarea')).toBeFocused();
 await sheet.locator('textarea').fill('Хорошее место для привала. '.repeat(12));
 await page.setViewportSize({width:320,height:568});
 await expect(sheet.locator('.raid-arrival-sheet__collapse')).toBeInViewport();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
 await page.screenshot({animations:'disabled',path:'output/playwright/participant-comment-320.png'});
 await sheet.getByRole('button',{name:'Добавить комментарий',exact:true}).scrollIntoViewIfNeeded();
 await expect(sheet.getByRole('button',{name:'Добавить комментарий',exact:true})).toBeInViewport();
 await expect(sheet.locator('.raid-arrival-sheet__collapse')).toBeInViewport();
 await sheet.getByRole('button',{name:'Комментарий',exact:true}).click();
 await sheet.getByText('История посещений',{exact:true}).click();
 await expect(sheet.getByText('2 раза',{exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({animations:'disabled',path:'output/playwright/participant-history.png'});
 await sheet.getByRole('button',{name:'Свернуть точку'}).click();
 await expect(sheet).toBeHidden();
 controls.mark('visit-two');
 await expect(page.locator('.visit-toast')).toBeVisible();
 await page.screenshot({animations:'disabled',path:'output/playwright/participant-toast.png'});
 await page.locator('.visit-toast__close').click();
 await expect(page.locator('.visit-toast')).toHaveCount(0);
});

test('navigator sees the five-minute repeat lock and map tap dismisses the sheet', async ({page}) => {
 const controls=await prepare(page,true);
 controls.mark('already-visited');
 const marker=page.getByRole('button',{name:'Лесное озеро. Вы уже были. История посещений'});
 await expect(marker).toBeVisible();
 await marker.click();
 const sheet=page.locator('.point-info-sheet');
 await expect(sheet.getByRole('button',{name:'Пометить точку снова'})).toBeDisabled();
 await expect(sheet.getByText(/Повторная отметка через/)).toBeVisible();
 await expect(sheet.locator('.raid-arrival-sheet__footer')).toBeInViewport();
 await page.screenshot({animations:'disabled',path:'output/playwright/navigator-cooldown.png'});
 await page.locator('.route-live-map').click({position:{x:35,y:260}});
 await expect(sheet).toBeHidden();
});

// Snapshot-driven UI contract; field-sync-server separately proves the real
// command is accepted before this notice, with its photo still uploading.
test('navigator confirmation opens the same point and deduplicates polling, repeats and reload', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const controls = await prepare(page, true)
  const success = page.getByRole('region', { name: 'Успешная отметка навигатора' })
  await expect(success).toHaveCount(0)
  controls.mark('navigator-first')
  await expect(success.getByText('Точка отмечена!', { exact: true })).toBeVisible()
  await expect(page.getByText('Вас отметили на точке', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('navigator-success.png'), animations: 'disabled' })
  await success.getByRole('button', { name: /Точка отмечена! Лесное озеро/ }).click()
  const sheet = page.locator('.point-info-sheet')
  await expect(sheet.getByRole('heading', { name: 'Лесное озеро', exact: true })).toBeVisible()
  await expect(sheet.locator('.raid-arrival-sheet__footer')).toBeInViewport()
  await sheet.getByRole('button', { name: 'Свернуть точку' }).click()
  controls.mark('navigator-first') // Same receipt, changed response/timestamp.
  for (let i = 0; i < 2; i++) await page.waitForResponse(response => response.url().includes('/fast/live') && response.ok())
  await expect(success).toHaveCount(0)
  controls.mark('navigator-second')
  await expect(success).toBeVisible()
  await success.getByRole('button', { name: 'Закрыть подтверждение навигатора' }).click()
  await page.reload()
  await expect(page.locator('.raid-active-map')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Лесное озеро. Вы уже были. История посещений' })).toBeVisible()
  for (let i = 0; i < 2; i++) await page.waitForResponse(response => response.url().includes('/fast/live') && response.ok())
  await expect(success).toHaveCount(0)
  expect(errors).toEqual([])
})

test('navigator notice respects reduced motion and stays usable on a small screen', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const controls = await prepare(page, true)
  await page.setViewportSize({ width: 320, height: 568 })
  controls.mark('small-screen')
  const success = page.getByRole('region', { name: 'Успешная отметка навигатора' })
  await expect(success).toBeVisible()
  await expect(success).toHaveCSS('animation-name', 'none')
  await expect(success.locator('.visit-toast__icon')).toHaveCSS('animation-name', 'none')
  const close = success.getByRole('button', { name: 'Закрыть подтверждение навигатора' })
  await expect(close).toBeInViewport()
  const box = await close.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const recovery = page.getByRole('region', { name: 'Состояние активного рейда' })
  await expect(recovery).toBeVisible()
  const toastBox = (await success.boundingBox())!, recoveryBox = (await recovery.boundingBox())!
  const controlsBox = (await page.getByRole('navigation', { name: 'Управление картой' }).boundingBox())!
  expect(recoveryBox.y).toBeGreaterThanOrEqual(toastBox.y + toastBox.height + 8)
  expect(controlsBox.y).toBeGreaterThanOrEqual(toastBox.y + toastBox.height + 8)
  await expect(recovery.getByRole('button', { name: 'Продолжить запись здесь' })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('navigator-success-320-reduced.png') })
  await close.click(); await expect(success).toHaveCount(0)
})
