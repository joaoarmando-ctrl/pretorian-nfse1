
import * as React from 'react'
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>){
  return <input {...props} className={`h-9 px-3 border rounded-md text-sm ${props.className||''}`} />
}
