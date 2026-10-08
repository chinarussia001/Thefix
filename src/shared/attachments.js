(() => {
  if (globalThis.__LOVABURST_ATTACHMENTS__) return;
  const MAX_FILES = 5, MAX_FILE_BYTES = 20 * 1024 * 1024, MAX_TOTAL_BYTES = 40 * 1024 * 1024;
  // File type support is destination-driven: ChatGPT remains the final authority.
  // LovaRPM only applies transport-safety limits for MV3 message serialization.
  const isImage = file => /^image\/(png|jpeg|webp)$/i.test(file?.type || "");
  function validate(file, current=[]) {
    if (!(file instanceof File) && !(file instanceof Blob)) return "Invalid file.";
    const name = String(file.name || "attachment");
    if (current.length >= MAX_FILES) return `Limit: ${MAX_FILES} attachments per submission.`;
    if (!file.size) return `${name} is empty.`;
    if (file.size > MAX_FILE_BYTES) return `${name} exceeds LovaRPM's 20 MB technical limit per file.`;
    const total = current.reduce((n,item)=>n+(item.file?.size||item.size||0),0) + file.size;
    if (total > MAX_TOTAL_BYTES) return "Attachments exceed LovaRPM's 40 MB total technical limit.";
    return "";
  }
  function make(file) {
    return { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, file, url: isImage(file) ? URL.createObjectURL(file) : "", name: file.name || `image-${Date.now()}.png`, type: file.type || "", size: file.size };
  }
  function release(item){ if(item?.url) URL.revokeObjectURL(item.url); }
  async function serialize(items) {
    return Promise.all(items.map(async item => {
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      let binary = ""; const chunk=0x8000;
      for(let i=0;i<bytes.length;i+=chunk) binary += String.fromCharCode(...bytes.subarray(i,i+chunk));
      return { name:item.name, type:item.type, size:item.size, base64:btoa(binary) };
    }));
  }
  function clipboardFiles(event) {
    const files=[];
    for (const item of Array.from(event.clipboardData?.items || [])) {
      if (item.kind !== "file") continue;
      const file=item.getAsFile(); if(file) files.push(file);
    }
    return files;
  }
  globalThis.__LOVABURST_ATTACHMENTS__={MAX_FILES,validate,make,release,serialize,clipboardFiles,isImage};
})();