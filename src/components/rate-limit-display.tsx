'use client';

import { Info, AlertCircle } from 'lucide-react';
import type { RateLimitInfo } from '@/lib/types';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useEffect, useState } from 'react';

interface RateLimitDisplayProps {
  rateLimit: RateLimitInfo | null;
  tone?: 'light' | 'dark';
}

export function RateLimitDisplay({ rateLimit, tone = 'light' }: RateLimitDisplayProps) {
  const [resetTime, setResetTime] = useState<string>('');

  useEffect(() => {
    if (rateLimit?.reset) {
      const resetDate = new Date(rateLimit.reset * 1000);
      const now = new Date();
      const diff = Math.round((resetDate.getTime() - now.getTime()) / 1000);

      if(diff > 0) {
        setResetTime(`in ${diff} seconds`);
        const interval = setInterval(() => {
            const newDiff = Math.round((resetDate.getTime() - new Date().getTime()) / 1000);
            if (newDiff > 0) {
                setResetTime(`in ${newDiff} seconds`);
            } else {
                setResetTime('now');
                clearInterval(interval);
            }
        }, 1000);
        return () => clearInterval(interval);
      } else {
        setResetTime('now');
      }
    }
  }, [rateLimit?.reset]);

  const limit = rateLimit?.limit;
  const remaining = rateLimit?.remaining;
  
  const areValuesInvalid = typeof limit !== 'number' || isNaN(limit) || typeof remaining !== 'number' || isNaN(remaining);

  if (!rateLimit || areValuesInvalid) {
    return (
      <div className={`w-full flex items-center gap-2 text-xs ${tone === 'dark' ? 'text-white/58' : 'text-muted-foreground'}`}>
        <Info className="h-4 w-4" />
        <span>API rate limit information will appear here.</span>
      </div>
    );
  }
  
  const isLow = remaining < limit * 0.2; // Show warning if below 20%

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`w-full flex cursor-help items-center gap-2 text-xs ${tone === 'dark' ? 'text-white/60' : 'text-muted-foreground'}`}>
            {isLow ? <AlertCircle className="h-4 w-4 text-destructive"/> : <Info className="h-4 w-4" />}
            <span>
              API Requests Remaining:{' '}
              <span className={`font-semibold ${isLow ? 'text-destructive' : tone === 'dark' ? 'text-white' : 'text-foreground'}`}>{remaining}</span> / {limit}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" align="start">
            <p>Your requests are subject to the Greenhouse API rate limit.</p>
            <p>The limit resets {resetTime}.</p>
            {isLow && <p className="text-destructive font-semibold mt-2">Warning: Approaching rate limit. App may pause to comply.</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
