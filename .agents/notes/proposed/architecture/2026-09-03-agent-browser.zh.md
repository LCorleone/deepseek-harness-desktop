# Agent ç¬è®°ï¼P8 Agent ç½é¡µæä½è½åï¼agent-browserï¼

ç¶æï¼Proposed

[English](2026-09-03-agent-browser.md) | ä¸­æ

## ç»è®ºéè§

P8 = è®© agent è½æä½çå®ç½é¡µï¼åµå¥å¼ webview é¡µé¢ + æå° CDP é¢ï¼DOM/Runtime/Input/Page ååï¼+ äººæºåä½æ¥ç®¡ãåç§ Minke è·¯çº¿ä½ä¸ç§å­æ¨¡åï¼å¨é¨èµ° dsh-plugin-desktop å¨æ host æä»¶ï¼å¸æ¶ scout-cua çå¨ä½è§èåä¸ä¸ä¸æç®¡çç»è®ºï¼æç»å¶èå¼±çå±é©ç¡®è®¤ãç®æ  CDP å± <1000 è¡ã

## å«èè¦ç¹

1. **çªå£/æè½½**ï¼ç¬ç« native-ui BrowserWindowï¼sso-gate åä¾ï¼ï¼ä¸»çªå£ `webviewTag` ä¿æ falseï¼æ°çªå£ `webviewTag:true + sandbox + contextIsolation + partition token`ï¼`will-attach-webview` æ¶æ¯ãguest æå¼¹çªï¼é»è®¤ 1120x760 / min 720x540ï¼v1 åçªå£å webviewãå·¥å·äºæ¥ãåå°ä¼è¯ææãElectron 43 webview ä»å¯ç¨ï¼embedder æ°¸ä¸èæ¬å guestï¼èªå¨åå¨èµ°ä¸»è¿ç¨ CDPï¼ã
2. **IPC ä¸ææ**ï¼å·²æ ¸å®ä»£ç ä¿®æ­£åæï¼ï¼host æ ç± main.ts `boot()` ç´æ¥è·å¨ Electron ä¸»è¿ç¨ï¼ä¸ `ElectronDesktopRuntime` åè¿ç¨ââå·¥å·âæ§è¡å¨æ¯è¿ç¨åè°ç¨ï¼æ°å¢ `desktopAgentBrowser` capabilityï¼main.ts provideï¼desktopActions åæ¬¾ï¼ãçå® IPC ä»ä¸¤æ®µï¼æµè§å¨çªå£ç¨æ° preload contextBridge + `webContents.send`ï¼Web å®¢æ·ç«¯æ¨ªå¹ç¨åæº loopback è·¯ç± + SSEï¼directory-picker åä¾ï¼ãæªå¾ç» `attachments.saveImage`âImageBlockï¼æ¥å¿ä¸è½ base64ã
3. **æå° CDP**ï¼ååå½ä»¤è¡¨è§è±æçï¼**ref=backendNodeIdï¼e<base36>ï¼ï¼generation åè°è®¡æ°å¨**ï¼å¯¼èª/DOM mutation/å¨ä½å®æå³ +1ï¼ï¼act å·¥å·æ ¡éª generationï¼è¿æè¿å STALE_SNAPSHOT éè¯¯åçââçº¦ 60 è¡ãè§å¯é¶æ³¨å¥ï¼DOM åæ éåï¼ï¼isolated world ä»ç¨äºåå®¡è®¡ç act å©æï¼focus/scroll/è¯»éææå¼ï¼ãä¸éè¦ Runtime.addBindingï¼æµç¨å¨ host åèµ·ï¼ä¸è½½/å¼¹çªèµ° Electron åçäºä»¶ï¼ãåæ ç¨ CSS px + æªå¾å£°æå°ºå¯¸ï¼cua çåè¾¨çå¯¹é½é®é¢æé æ§è§é¿ï¼**backendNodeId ä¼åãåæ ååº**ã
4. **å·¥å·éä¸æç¤ºè¯**ï¼`browser_open/navigate/snapshot/click/type/scroll/wait/screenshot/claim_control` ä¹ä»¶ï¼host å¨å±å±æ³¨åï¼locked æå»ºå preset ç­ä»·å¯è§ï¼ï¼OBSERVEâRESOLVEâACTâVERIFY çºªå¾ + å¨æä¸ä¸æï¼å½å URL/generation/claim æï¼ç» `ctx.systemPrompt.section/context` æ³¨å¥ã**å¨ä½ normalizer**ï¼cua æè®­â ï¼ï¼execute åçº¯å½æ°è§èåå«ååæ°ï¼left_click/coordinate/ref_id/æ  scheme url ç­ï¼~150 è¡ãéè¯¯ååï¼STALE/REF_NOT_FOUND èªçº åçãOPERATOR_HAS_CONTROL å¿«éå¤±è´¥ãç¬æ¶ CDP éè¯¯éé¿éè¯ï¼â¤3 æ¬¡ â¤2sï¼ã
5. **å®å¨çº¢çº¿è½å°**ï¼â å±é©å¨ä½ï¼è·¨æºå¯¼èª/è¡¨åæäº¤/ä¸è½½ï¼èµ° `tools/pre-execute`âaskâç°æ ApprovalService å®¡æ¹ UIï¼ä¸æ°å»ºé¢ï¼â¡partition é»è®¤ä¸æ¬¡æ§éæº tokenï¼`persist:` é policy `agentBrowser.allowPersistLogin` + ç¨æ·æ¾å¼å¼å¯ï¼cookie å å¯ fuse å·²å¼ï¼æ æ°å¯é¥ï¼ï¼å¯ä¸é®æ¸é¤ï¼â¢å¯ç æ¡ä¸éå±è½ï¼å¿«ç§ host ä¾§è¿æ»¤ + isolated world æåç½ååä¸è¯» value + browser_type ç¡¬æå¹¶æå¼ claimControlï¼æªå¾é åçåç¹ï¼ï¼â£claimControl ä¸å¥å£ï¼çªå£æé®/å®¢æ·ç«¯æ¨ªå¹/æ¨¡åå·¥å·ï¼ï¼claimed æ act å¿«éå¤±è´¥ãin-flight èµ° signal ä¸­æ­¢ãåæ é«äº®ç± overlay å±ç»ï¼getBoxModel åæ ï¼é¶é¡µé¢æ³¨å¥ï¼ï¼â¤desktop-policy æ°å¢ `agentBrowser{enabled,allowOrigins,allowPersistLogin}` é®ï¼ä¸¥æ ¼è§£æå¨ 9â10ãç¯å¢äº¤æ¥ 6â7ãä¸¤ä¸ª policy JSON + specï¼ï¼locked é»è®¤æãdev é»è®¤ `*`ï¼éå®åé¾ç» URL ä¹è¿ allowlistï¼è¿è§å¯¼èª denyã
6. **æ¸²æç«¯è¾¹ç**ï¼client/native-ui å¨é¨ Node-freeï¼æ¢æ renderer-node-globals æºå¨é¨èªå¨è¦çæ°æä»¶ï¼webview æ¯ guest è¿ç¨ DOM åç´ ä¸å¨é¨ç¦è¯­ä¹åã
7. **æ¹æ¬¡**ï¼B1 åªè¯»é­ç¯ï¼çªå£+CDP+å¿«ç§/screenshot+prompt section+policy éª¨æ¶ï¼4â5dï¼â B2 å¨ä½é­ç¯ï¼click/type/scroll+normalizer+å®¡æ¹+å¯ç æç»+overlay+claim ç¶ææºï¼4â5dï¼â B3 äººæºåä½+ç»å½æï¼SSE+æ¨ªå¹+claim_control+partition/persistLoginï¼3â4dï¼â B4 ç­ç¥+æç£¨ï¼allowlist/éå®å/ä¸è½½ãæªå¾ä¿®åªæç¤ºãçº¢çº¿æµè¯ãfallback spikeï¼3â4dï¼ãæ¯æ¹æä»¶æ¸åä¸éªæ¶æµè¯è§è±æçã
8. **é£é©ä¸éçº§**ï¼webviewãä¸æ¨èãå§¿æï¼ééå¨éç¦»ï¼B4 spike WebContentsView fallbackï¼ï¼DevTools æ¢ debuggerï¼detach éè¿ä¸æ¬¡ï¼ï¼åå CDP ç¨³å®ï¼0.1.2 è¦å = 5 ä¸ªç¨³å® seam + policy ç¯å¢äº¤æ¥æ¡æ°ï¼åè®¡ **14â18 äººæ¥**ã

## å¤é¨åç§åèè®°å½

- é Minkeï¼webview+debugger è·¯çº¿ãDOM åå¿«ç§+resolveNodeãInput çå®è¾å¥ãPage æªå¾ï¼ä¸éç§å½å­æ¨¡åä¸ 4.8k è¡ CDPã
- é cuaï¼å¨ä½ normalizerï¼OperatorNormalizerCallback ååï¼ãç­ç¥æçå½å¨æé©å­ï¼æ å°å° dsh æ¢æ tools/execute åè£å¨ãpost-executeãcompaction prunerãsystemPrompt.contextï¼ä¸å»ºæ°æºå¶ï¼ãæè¿ N å¼ æªå¾ä¿çï¼attachment+prune hintï¼ãç¬æ¶/è´å½éè¯¯ååãbackendNodeId ä¼ååæ ååºã
- ä¸å­¦ cuaï¼å±é©å¨ä½ç¡®è®¤èªå»ºï¼å¶ URL é»ååä»æ¯ TODOï¼ï¼human_tool äººèéåè¿éä¸éç¨ã

## æä»¶çº§æ¹å¨æ¸å

è§è±æçãFile-level change listãï¼æ°å¢ `src/agent-browser-{contract,cdp,session,window,preload,normalize,policy}.ts`ã`src/agent-browser.ts`ã`src/native-ui/agent-browser/*`ã`src/client/agent-browser-ui.tsx` åéå¥ specsï¼ä¿®æ¹ `package.json`ã`tsdown.config.ts`ã`vite.native-ui.config.ts`ã`cordis.patch.yml`ã`src/desktop-policy.ts`ã`src/policy/*.json`ã`src/main.ts`ã`src/client/index.ts`ã`agent-presets/deloitte-standard/agent.cordis.yml`ï¼ä¿®åªéå¼ï¼ãä¸å¨å­æ¨¡åãä¸å¨ dsh-community-market è¿è¡æ¶ãä¸å¨ä¸»çªå£ webPreferencesã
