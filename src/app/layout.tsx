import './globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Importador de NFS-e • Pretorian',
  description: 'Importa NFS-e em lote e exporta TXT + XLSX.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-br">
      <body className="bg-white text-slate-900">{children}</body>
    </html>
  )
}
