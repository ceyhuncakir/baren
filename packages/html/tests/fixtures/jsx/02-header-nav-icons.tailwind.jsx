(
    <div className="flex items-center justify-between h-16 shrink-0 py-0 px-8 border-b [border-bottom-style:solid] border-b-border bg-background">
      <div className="flex items-center gap-[10px]">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="w-6 h-6">
          <rect width="24" height="24" rx="6" fill="var(--color-primary)" />
          <path d="M7 12h10M12 7v10" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div className="text-[15px] tracking-[-0.01em] font-sans font-semibold text-foreground">
          Northwind
        </div>
      </div>
      <div className="flex items-center gap-7">
        <div className="text-[14px] font-sans text-foreground">
          Product
        </div>
        <div className="text-[14px] font-sans text-foreground-muted">
          Pricing
        </div>
        <div className="text-[14px] font-sans text-foreground-muted">
          Docs
        </div>
      </div>
      <div className="flex items-center gap-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[18px] h-[18px]">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <div className="flex items-center h-8 py-0 px-[14px] rounded-md bg-primary text-base font-sans font-medium text-primary-foreground">
          Sign up
        </div>
      </div>
    </div>
  )
