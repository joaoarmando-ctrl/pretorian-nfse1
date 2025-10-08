
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, startTransition } from "react";
import * as pdfjsLib from "pdfjs-dist";
import * as XLSX from "xlsx";
import { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";

// pdf.js worker via CDN
// @ts-ignore
pdfjsLib.GlobalWorkerOptions.workerSrc = "//cdnjs.cloudflare.com/ajax/libs/pdf.js/4.3.136/pdf.worker.min.js";

const CONFIG = { CONCURRENCY_PDF: 4, OCR_PAGE_TIMEOUT_MS: 30000 };
const MAX_FILES = 100;

const DEFAULT_SCHEMA = [
  "cnpj_prestador","razao_social_prestador","uf_prestador","municipio_prestador","endereco_prestador",
  "numero_nota","serie","data_emissao","data_competencia","deducoes",
  "flag_personalizado_1","codigo_interno_personalizado",
  "valor_bruto","descontos","base_calculo","valor_iss","aliquota_iss_percent","valor_liquido",
  "inss","iss_retido_flag","valor_pis","valor_cofins","valor_csll","valor_irrf","outros",
  "codigo_servico","campo_reservado1","campo_reservado2"
] as const;

type SchemaCampo = typeof DEFAULT_SCHEMA[number];

type FileJob = {
  id: string; file: File; status: 'PENDENTE'|'PROCESSANDO'|'OK'|'ERRO'|'IGNORADO'; progress: number; error?: string; noteCount?: number;
};
type RegistroBase = { id: string; fileId: string; origem: { arquivo: string; pagina?: number }; [k: string]: any; _erros?: string[]; _avisos?: string[] };

class Semaphore {
  private queue: Array<() => void> = []; private count: number;
  constructor(capacity: number){ this.count = capacity; }
  async acquire(){ if(this.count>0){ this.count--; return } await new Promise<void>(res => this.queue.push(res)); }
  release(){ this.count++; if(this.count>0 && this.queue.length){ this.count--; const res=this.queue.shift(); res && res(); } }
}

const valorBR = z.string().optional().transform(s => { if(!s) return undefined; const n=Number(s.replace(/\./g,'').replace(',','.')); return Number.isFinite(n)? n: undefined; });
const dataBR = z.string().regex(/^(\d{2})\/(\d{2})\/(\d{4})$/).optional();
const registroSchema = z.object({
  cnpj_prestador: z.string().regex(/\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-\d{2}\b/).optional(),
  razao_social_prestador: z.string().optional(),
  uf_prestador: z.string().length(2).optional(),
  municipio_prestador: z.string().optional(),
  endereco_prestador: z.string().optional(),
  numero_nota: z.string().optional(),
  serie: z.string().optional(),
  data_emissao: dataBR,
  data_competencia: dataBR,
  deducoes: valorBR,
  flag_personalizado_1: z.union([z.string(), z.boolean()]).optional(),
  codigo_interno_personalizado: z.string().optional(),
  valor_bruto: valorBR,
  descontos: valorBR,
  base_calculo: valorBR,
  valor_iss: valorBR,
  aliquota_iss_percent: valorBR,
  valor_liquido: valorBR,
  inss: valorBR,
  iss_retido_flag: z.union([z.literal(true), z.literal(false)]).optional(),
  valor_pis: valorBR,
  valor_cofins: valorBR,
  valor_csll: valorBR,
  valor_irrf: valorBR,
  outros: valorBR,
  codigo_servico: z.string().optional(),
  campo_reservado1: z.string().optional(),
  campo_reservado2: z.string().optional(),
});

function roundHalfEven(n: number, d=2){ const f=10**d; const x=n*f; const r=Math.round(x); const diff=Math.abs(x-r); if(diff===0.5){ return (Math.floor(x)%2===0? Math.floor(x):Math.ceil(x))/f } return Math.round(x)/f }
function formatMoneyOut(n: number | undefined, locale:"pt"|"en"="pt"){ if(typeof n!=='number'||Number.isNaN(n)) return ''; const s=roundHalfEven(n,2).toFixed(2); return locale==='pt'? s.replace('.',','): s; }
function maskCNPJ(s?: string){ if(!s) return ''; const d=s.replace(/\D/g,'').slice(0,14); return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,'$1.$2.$3/$4-$5'); }

async function extractTextFromPdfOrOcr(file: File, onProgress?: (p:number)=>void): Promise<{pages: string[]}> {
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const pages: string[] = [];
  for (let i=1;i<=pdf.numPages;i++){
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it:any) => ('str' in it ? it.str : '')).join('\\n').trim();
    let finalText = text;
    if (finalText.length < 20) {
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx as any, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/png');
      finalText = await ocrWithTimeout(dataUrl, CONFIG.OCR_PAGE_TIMEOUT_MS);
    }
    pages.push(finalText);
    onProgress?.(Math.round((i/pdf.numPages)*100));
  }
  return { pages };
}

async function ocrWithTimeout(dataUrl: string, timeoutMs: number): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker({ logger: () => {} });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { worker.terminate(); } catch {} }, timeoutMs);
  try {
    await worker.loadLanguage('por+eng');
    await worker.initialize('por+eng');
    const { data } = await worker.recognize(dataUrl);
    return (data.text || "").replace(/\s+\n/g, "\n").trim();
  } catch (e:any) {
    return "";
  } finally {
    clearTimeout(timer);
    if (!timedOut) { try { await worker.terminate(); } catch {} }
  }
}

const LABELS = {
  emissao: [/data\s*de\s*emiss[aã]o/i, /emiss[aã]o/i],
  competencia: [/compet[eê]ncia/i],
  valorServico: [/valor\s*(do\s*)?servi[cç]o?s?/i, /total\s*do\s*servi[cç]o/i],
  deducoes: [/dedu[cç][oõ]es/i],
  base: [/base\s*de\s*c[aá]lculo/i],
  aliquota: [/al[ií]quota\s*iss/i, /iss\s*\(%\)/i, /aliquota\s*issqn/i],
  valorISS: [/valor\s*iss(?!p)/i, /iss\s*\(r\$\)/i, /issqn\s*valor/i],
  issRetido: [/iss\s*retido/i, /retido\s*pelo\s*tomador/i],
  pis: [/pis(\/pasep)?/i],
  cofins: [/cofins/i],
  csll: [/csll/i],
  irrf: [/irrf|ir\s*rf|imposto\s*de\s*renda\s*retido/i],
  inss: [/inss/i],
};

function findFirstRegex(text: string, regs: RegExp[]) { for(const r of regs){ const m=text.match(r); if(m) return m[0]; } }
function findMoney(text: string, near: RegExp[]): string | undefined {
  const line = findFirstRegex(text, near);
  if(!line) return undefined;
  const sliceStart = Math.max(0, text.indexOf(line) - 80);
  const slice = text.slice(sliceStart, sliceStart + 220);
  const money = slice.match(/(?:(?:R\$)\s*)?\d{1,3}(?:\.\d{3})*,\d{2}/);
  return money?.[0];
}
function valorFrom(s?: string){ if(!s) return undefined; const norm=s.replace(/\./g,"").replace(",","."); const n=Number(norm.replace(/[^0-9.]/g, "")); return Number.isFinite(n)? n: undefined; }
function dateFromLine(text: string, anchor?: string){ if(!anchor) return undefined; const idx=text.indexOf(anchor); if(idx===-1) return undefined; const tail=text.slice(idx, idx+120); const m=tail.match(/\b\d{2}\/\d{2}\/\d{4}\b/); return m?.[0]; }

function parsePagesToRegistros(pages: string[], fileName: string): RegistroBase[] {
  const joined = pages.join("\\n\\n");
  const reg: RegistroBase = { id: crypto.randomUUID(), fileId: fileName, origem: { arquivo: fileName } };
  reg.valor_bruto = valorFrom(findMoney(joined, LABELS.valorServico));
  reg.deducoes = valorFrom(findMoney(joined, LABELS.deducoes));
  reg.base_calculo = valorFrom(findMoney(joined, LABELS.base));
  reg.aliquota_iss_percent = valorFrom(findMoney(joined, LABELS.aliquota));
  reg.valor_iss = valorFrom(findMoney(joined, LABELS.valorISS));
  reg.valor_pis = valorFrom(findMoney(joined, LABELS.pis));
  reg.valor_cofins = valorFrom(findMoney(joined, LABELS.cofins));
  reg.valor_csll = valorFrom(findMoney(joined, LABELS.csll));
  reg.valor_irrf = valorFrom(findMoney(joined, LABELS.irrf));
  reg.inss = valorFrom(findMoney(joined, LABELS.inss));
  reg.data_emissao = dateFromLine(joined, findFirstRegex(joined, LABELS.emissao));
  reg.data_competencia = dateFromLine(joined, findFirstRegex(joined, LABELS.competencia));
  reg.iss_retido_flag = /iss\s*retido|retido\s*pelo\s*tomador/i.test(joined) ? true : undefined;
  return [reg];
}

function buildTxt(registros: RegistroBase[], schema: string[], sep = ";", decimal:"pt"|"en"="pt"){
  const lines: string[] = [];
  for(const r of registros){
    const row = schema.map((campo)=>{
      const v = (r as any)[campo];
      if(typeof v === "number") return formatMoneyOut(v, decimal);
      if(campo.includes("cnpj")) return maskCNPJ(v);
      return v ?? "";
    }).join(sep);
    lines.push(row);
  }
  return lines.join("\\n");
}

function buildXlsxTributos(registros: RegistroBase[]){
  const rows = registros.map((r)=> ({
    Nota: r.numero_nota ?? "",
    Prestador: r.razao_social_prestador ?? "",
    Municipio: r.municipio_prestador ?? "",
    ISS: r.valor_iss ?? "",
    IRRF: r.valor_irrf ?? "",
    INSS: r.inss ?? "",
    PIS: r.valor_pis ?? "",
    COFINS: r.valor_cofins ?? "",
    CSLL: r.valor_csll ?? "",
    BaseCalculo: r.base_calculo ?? "",
    ValorBruto: r.valor_bruto ?? "",
    ValorLiquido: r.valor_liquido ?? "",
    ISSRetido: r.iss_retido_flag === true ? "SIM" : r.iss_retido_flag === false ? "NÃO" : "",
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Tributos");
  return wb;
}

// LocalStorage helpers
const LS_SCHEMA_KEY = "pretorian_schema_layout";
const LS_DECIMAL_KEY = "pretorian_decimal";

export default function Page(){
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [registros, setRegistros] = useState<RegistroBase[]>([]);
  const [running, setRunning] = useState(false);
  const [schemaCampos, setSchemaCampos] = useState<string[]>(() => JSON.parse(typeof window==='undefined' ? 'null' : (localStorage.getItem(LS_SCHEMA_KEY) || "null")) || DEFAULT_SCHEMA);
  const [decimalOut, setDecimalOut] = useState<'pt'|'en'>(() => (typeof window==='undefined' ? 'pt' : ((localStorage.getItem(LS_DECIMAL_KEY) as any) || 'pt')));
  const pdfSem = useRef(new Semaphore(CONFIG.CONCURRENCY_PDF));

  const onFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files);
    const remaining = Math.max(0, MAX_FILES - jobs.length);
    if (remaining === 0) { alert(`Limite de ${MAX_FILES} PDFs atingido.`); return; }
    const selected = arr.slice(0, remaining);
    const dropped = arr.length - selected.length;
    const append: FileJob[] = selected.map((file) => ({ id: crypto.randomUUID(), file, status: 'PENDENTE', progress: 0 }));
    setJobs((prev) => [...append, ...prev]);
    if (dropped > 0) alert(`${dropped} arquivo(s) excederam o limite de ${MAX_FILES}.`);
  }, [jobs.length]);

  useEffect(() => { if (typeof window!=='undefined') localStorage.setItem(LS_SCHEMA_KEY, JSON.stringify(schemaCampos)); }, [schemaCampos]);
  useEffect(() => { if (typeof window!=='undefined') localStorage.setItem(LS_DECIMAL_KEY, decimalOut); }, [decimalOut]);

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    const run = async () => {
      for (const job of jobs) {
        if (cancelled) break;
        if (job.status !== 'PENDENTE') continue;
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'PROCESSANDO', progress: 1 } : j));
        try {
          await pdfSem.current.acquire();
          const { pages } = await extractTextFromPdfOrOcr(job.file, (p)=>{
            startTransition(()=> setJobs(prev => prev.map(j => j.id===job.id ? { ...j, progress: p } : j)));
          });
          pdfSem.current.release();
          const regs = parsePagesToRegistros(pages, job.file.name);
          // validação (coleta de erros sem bloquear)
          regs.forEach(r => {
            const partial: any = {};
            schemaCampos.forEach(k => (partial[k] = (r as any)[k]));
            const parsed = registroSchema.safeParse(partial);
            if (!parsed.success) r._erros = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
          });
          setRegistros(prev => [...prev, ...regs]);
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'OK', progress: 100, noteCount: regs.length } : j));
        } catch (e:any) {
          pdfSem.current.release();
          setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'ERRO', error: e?.message || String(e), progress: 100 } : j));
        }
      }
      setRunning(false);
    };
    run();
    return () => { cancelled = true; };
  }, [running, jobs, schemaCampos]);

  const handleExport = useCallback(() => {
    if (!registros.length) return alert("Nenhum registro para exportar");
    const txt = buildTxt(registros, schemaCampos, ";", decimalOut);
    const blobTxt = new Blob([txt], { type: "text/plain;charset=utf-8" });
    const ts = new Date();
    const pad = (n:number)=> String(n).padStart(2,'0');
    const nameTxt = `servicos_tomados_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.txt`;
    downloadBlob(blobTxt, nameTxt);

    const wb = buildXlsxTributos(registros);
    const wbout = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blobX = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const nameX = `servicos_tomados_relatorio_tributos_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.xlsx`;
    downloadBlob(blobX, nameX);
  }, [registros, schemaCampos, decimalOut]);

  // Drag-and-drop simples (HTML5) para reordenar schema
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const onDragStart = (idx:number) => setDragIndex(idx);
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); };
  const onDrop = (idx:number) => {
    if (dragIndex===null || dragIndex===idx) return;
    const arr = [...schemaCampos];
    const [moved] = arr.splice(dragIndex, 1);
    arr.splice(idx, 0, moved);
    setSchemaCampos(arr);
    setDragIndex(null);
  };

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white">
        <div className="container py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded bg-brand" />
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-brand">Pretorian • Importador de NFS‑e</h1>
              <p className="text-xs text-slate-500">Processamento em lote • OCR fallback • TXT + XLSX</p>
            </div>
          </div>
          <div className="hidden md:flex items-center gap-3">
            <button className="px-3 py-2 rounded bg-brand text-white" onClick={()=>document.getElementById('file')?.click()}>Selecionar PDFs</button>
            <button className="px-3 py-2 rounded border" onClick={()=>setRunning(true)}>Iniciar Fila</button>
          </div>
        </div>
      </header>

      <main className="container py-8 space-y-8">
        {/* Upload */}
        <section className="space-y-3">
          <div className="flex gap-2 items-center">
            <Input id="file" type="file" multiple accept="application/pdf" onChange={(e)=>onFiles(e.target.files)} />
            <Button variant="ghost" onClick={()=>{ setJobs([]); setRegistros([]); }}>Limpar</Button>
          </div>
          <div className="text-xs text-slate-500">Arquivos adicionados: {jobs.length}/{MAX_FILES}</div>
        </section>

        {/* Fila */}
        <section>
          <h2 className="font-medium mb-2">Fila</h2>
          <div className="grid md:grid-cols-2 gap-3">
            {jobs.map(j => (
              <Card key={j.id}>
                <CardHeader>
                  <CardTitle className="truncate" title={j.file.name}>{j.file.name}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-xs text-slate-500 mb-2">Status: {j.status} • {j.progress}%</div>
                  <Progress value={j.progress} />
                  {j.error && <div className="text-xs text-red-600 mt-1">{j.error}</div>}
                </CardContent>
              </Card>
            ))}
            {jobs.length === 0 && <div className="text-sm text-slate-500">Nenhum arquivo na fila.</div>}
          </div>
        </section>

        {/* Configurar Layout TXT */}
        <section>
          <h2 className="font-medium mb-2">Configurar Layout TXT</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <p className="text-xs text-slate-500 mb-2">Arraste para reordenar os campos do TXT:</p>
              <div className="dropzone space-y-2">
                {schemaCampos.map((c, idx) => (
                  <div key={c}
                    draggable
                    onDragStart={()=>onDragStart(idx)}
                    onDragOver={onDragOver}
                    onDrop={()=>onDrop(idx)}
                    className="draggable flex items-center justify-between">
                    <span>{idx+1}. {c}</span>
                    <div className="text-[10px] text-slate-500">arraste</div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-2">Máscaras e formatação:</p>
              <div className="grid gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <span>Formato decimal do TXT</span>
                  <select className="border rounded px-2 py-1 text-sm"
                    value={decimalOut}
                    onChange={e=>setDecimalOut(e.target.value as 'pt'|'en')}>
                    <option value="pt">pt-br (,)</option>
                    <option value="en">en (.)</option>
                  </select>
                </label>
                <p className="text-xs text-slate-500">CNPJ sempre exportado com máscara 99.999.999/9999-99.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Consolidação */}
        <section>
          <h2 className="font-medium mb-2">Consolidação</h2>
          <div className="overflow-auto border rounded">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  {schemaCampos.map(h => <th key={h} className="text-left p-2 border-b">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {registros.map(r => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    {schemaCampos.map(h => (
                      <td key={h} className="p-2 border-b align-top">{String((r as any)[h] ?? "")}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Export */}
        <section className="flex gap-3 items-center">
          <Button onClick={handleExport}>Exportar TXT + XLSX</Button>
        </section>
      </main>

      <footer className="border-t mt-8">
        <div className="container py-8 grid md:grid-cols-3 gap-6 text-sm">
          <div>
            <h3 className="font-semibold">Pretorian Contabilidade</h3>
            <p className="text-slate-500 mt-1">Vamos mostrar como podemos ajudar a superar seus desafios financeiros.</p>
          </div>
          <div>
            <h4 className="font-medium">Endereço</h4>
            <p className="text-slate-500">Rua José Monteiro Sobrinho, 19 - Serraria<br/>Maceió - AL - CEP 57046-780</p>
          </div>
          <div>
            <h4 className="font-medium">Contato</h4>
            <p className="text-slate-500">Telefone: (82) 3035-4642<br/>Email: comercial@pretorian.net.br</p>
          </div>
        </div>
      </footer>
    </div>
  )
}

function downloadBlob(blob: Blob, filename: string){
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = filename; a.click();
  setTimeout(()=> URL.revokeObjectURL(url), 1500);
}
