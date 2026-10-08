(() => {
  if (window.__LOVABURST_LOGO_REFRESH_V0215__) return;
  window.__LOVABURST_LOGO_REFRESH_V0215__ = true;
  const LOGO=chrome.runtime.getURL("assets/logo.png");
  function apply(){const host=document.getElementById("lovaburst-composer-ui");const shadow=host?.shadowRoot;const slot=shadow?.querySelector(".lb-toast-mark, .lb-toast-logo");if(!slot||slot.dataset.logoV0215==="true")return;slot.dataset.logoV0215="true";slot.innerHTML="";const img=document.createElement("img");img.src=LOGO;img.alt="";img.setAttribute("aria-hidden","true");img.style.cssText="width:100%;height:100%;display:block;object-fit:contain";slot.appendChild(img)}
  const observer=new MutationObserver(apply);observer.observe(document.documentElement,{childList:true,subtree:true});apply();
})();
