'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { useEffect, useState } from 'react';
import { watchSessionChanges } from '@/lib/session';
import { workflowSocket } from '@/lib/socket-client';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      })
  );
  useEffect(() => watchSessionChanges(() => {
    workflowSocket.disconnect();
    void queryClient.cancelQueries();
    queryClient.clear();
  }), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <NuqsAdapter>
        {children}
        {process.env.NODE_ENV === 'development' && (
          <ReactQueryDevtools initialIsOpen={false} />
        )}
      </NuqsAdapter>
    </QueryClientProvider>
  );
}
