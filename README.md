
# Pretorian • Importador de NFS-e (Next.js + Tailwind) + OCR

Importa NFS-e em lote (até 100 PDFs), com **fallback de OCR (tesseract.js)** por página quando o PDF não tem texto.
Exporta simultaneamente:
- TXT padrão "Serviços Tomados" (ordem configurável via drag-and-drop)
- XLSX com tributos por nota

## Rodar localmente
```bash
npm i
npm run dev
# http://localhost:3000
```

## Deploy (Vercel)
1. Suba este diretório para um repositório no GitHub.
2. Em https://vercel.com/import → Import Project → selecione o repo.
3. Framework: Next.js (detectado automaticamente).
4. Deploy.

## Observações
- pdf.js worker por CDN definido em `page.tsx`.
- OCR: usa tesseract.js com `por+eng` e timeout por página (30s). Em páginas com texto digital, **não** roda OCR.
- Layout do TXT: arraste os campos para reordenar (persistido em localStorage).
- Limite de upload: 100 PDFs (ajustável em `page.tsx`).
