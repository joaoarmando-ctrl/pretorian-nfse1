
import * as React from 'react'
import clsx from 'clsx'
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default'|'secondary'|'ghost'
}
export function Button({ className, variant='default', ...props }: ButtonProps){
  const base = 'inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-3 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none'
  const styles = {
    default: 'bg-brand text-white hover:opacity-90 focus:ring-brand',
    secondary: 'bg-slate-100 hover:bg-slate-200 text-slate-900 focus:ring-slate-400',
    ghost: 'bg-transparent hover:bg-slate-100 text-slate-900 focus:ring-slate-300',
  }[variant]
  return <button className={clsx(base, styles, className)} {...props} />
}
export default Button
