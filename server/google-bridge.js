import { FRONTEND_ORIGIN } from '../shared/deployment.js';

// Keep GIS on its already-authorized Render origin. The token crosses only to
// our exact frontend and is still verified by Google's API on the backend.
export function googleBridge(clientId, language, parent = FRONTEND_ORIGIN) {
  const config = JSON.stringify({ clientId, parent, language }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:transparent}#google{display:flex;justify-content:center;min-height:44px}</style><div id="google"></div><script>
  var config=${config};
  function ready(){
    if(window.parent===window)return;
    google.accounts.id.initialize({client_id:config.clientId,callback:function(result){
      window.parent.postMessage({type:'emtidad-google-credential',credential:result.credential},config.parent);
    }});
    google.accounts.id.renderButton(document.getElementById('google'),{theme:'outline',size:'large',shape:'pill',text:'continue_with',locale:config.language,width:Math.min(360,document.documentElement.clientWidth)});
  }</script><script src="https://accounts.google.com/gsi/client?hl=${language}" async defer onload="ready()"></script></html>`;
}
