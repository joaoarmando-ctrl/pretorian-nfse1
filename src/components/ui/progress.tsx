
import * as React from 'react'
export function Progress({ value=0 }:{ value?: number }){
  return (
    <div className="w-full h-2 bg-slate-200 rounded">
      <div className="h-2 bg-accent rounded" style={{ width: `${Math.min(100, Math.max(0, value))}%`}} />
    </div>
  )
}
