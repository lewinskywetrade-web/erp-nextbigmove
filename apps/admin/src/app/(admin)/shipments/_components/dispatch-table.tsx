'use client';

import type {
  WmsDispatchReturnListItem,
  WmsDispatchTab,
  WmsDispatchTaskListItem,
} from '../_types/dispatch';

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

type DispatchTableProps = {
  tab: WmsDispatchTab;
  outboundTasks: WmsDispatchTaskListItem[];
  returnTasks: WmsDispatchReturnListItem[];
  isLoading: boolean;
  onSelectTask: (taskId: string) => void;
};

export function DispatchTable({
  tab,
  outboundTasks,
  returnTasks,
  isLoading,
  onSelectTask,
}: DispatchTableProps) {
  const columnCount = tab === 'returns' ? 9 : 8;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left">
        <thead className="border-b border-[#dce4ea] bg-[#f8fbfc]">
          <tr className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#728697]">
            <th className="px-5 py-4">Date</th>
            <th className="px-5 py-4">Order</th>
            <th className="px-5 py-4">Customer</th>
            <th className="px-5 py-4">Waybill</th>
            <th className="px-5 py-4">{tab === 'returns' ? 'Return State' : 'Dispatch'}</th>
            <th className="px-5 py-4">Units</th>
            {tab === 'returns' ? <th className="px-5 py-4">Disposed By</th> : null}
            <th className="px-5 py-4">Store</th>
            <th className="px-5 py-4 text-right">Action</th>
          </tr>
        </thead>

        <tbody className="bg-white">
          {isLoading ? (
            Array.from({ length: 8 }).map((_, index) => (
              <tr key={`loading-${index}`} className="border-b border-[#edf2f6]">
                {Array.from({ length: columnCount }).map((__, cellIndex) => (
                  <td key={`loading-${index}-${cellIndex}`} className="px-5 py-4">
                    <div className="h-3.5 animate-pulse rounded-full bg-[#eef2f5]" />
                  </td>
                ))}
              </tr>
            ))
          ) : tab === 'returns' ? (
            returnTasks.length === 0 ? (
              <EmptyState colSpan={columnCount} message="No return orders are in the dispatch queue yet." />
            ) : (
              returnTasks.map((entry) => (
                <DispatchReturnRow
                  key={entry.task.id}
                  entry={entry}
                  onSelect={() => onSelectTask(entry.task.id)}
                />
              ))
            )
          ) : outboundTasks.length === 0 ? (
            <EmptyState colSpan={columnCount} message="No outbound dispatch orders are available yet." />
          ) : (
            outboundTasks.map((task) => (
              <DispatchOutboundRow
                key={task.id}
                task={task}
                onSelect={() => onSelectTask(task.id)}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function DispatchOutboundRow({
  task,
  onSelect,
}: {
  task: WmsDispatchTaskListItem;
  onSelect: () => void;
}) {
  return (
    <tr className="cursor-pointer border-b border-[#edf2f6] transition hover:bg-[#f8fbfc]" onClick={onSelect}>
      <td className="px-5 py-4 text-sm font-medium text-[#506879]">
        {formatDate(task.orderDateLocal ?? task.orderDate)}
      </td>
      <td className="px-5 py-4">
        <div className="min-w-0">
          <p className="font-semibold text-primary">#{task.posOrderId}</p>
          <p className="mt-1 text-sm text-[#678090]">{task.store?.tenantName ?? 'Client'}</p>
        </div>
      </td>
      <td className="px-5 py-4 text-sm text-primary">{task.customer.name ?? 'Unknown customer'}</td>
      <td className="px-5 py-4">
        <span className="font-mono text-[13px] font-semibold text-[#385164]">
          {task.tracking ?? 'Awaiting tracking'}
        </span>
      </td>
      <td className="px-5 py-4">
        <span className={buildStatusPill(task.delivery?.status ?? task.status)}>
          {task.delivery?.label ?? task.statusLabel}
        </span>
      </td>
      <td className="px-5 py-4">
        <p className="text-sm font-semibold text-primary">{task.totals.packed}/{task.totals.required}</p>
        <p className="mt-1 text-xs text-[#708596]">Packed / required</p>
      </td>
      <td className="px-5 py-4 text-sm text-[#506879]">{task.store?.name ?? 'Unassigned'}</td>
      <td className="px-5 py-4 text-right">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          className="btn btn-sm btn-outline"
        >
          View
        </button>
      </td>
    </tr>
  );
}

function DispatchReturnRow({
  entry,
  onSelect,
}: {
  entry: WmsDispatchReturnListItem;
  onSelect: () => void;
}) {
  const { task, returnSummary } = entry;
  const unitsCaption = returnSummary.awaitingPlacementUnits > 0
    ? `${returnSummary.awaitingPlacementUnits} awaiting placement`
    : returnSummary.pendingUnits > 0
      ? `${returnSummary.pendingUnits} pending`
      : returnSummary.placedUnits > 0
        ? `${returnSummary.placedUnits} placed`
        : 'No linked units';

  return (
    <tr className="cursor-pointer border-b border-[#edf2f6] transition hover:bg-[#f8fbfc]" onClick={onSelect}>
      <td className="px-5 py-4 text-sm font-medium text-[#506879]">
        {formatDate(task.orderDateLocal ?? task.orderDate)}
      </td>
      <td className="px-5 py-4">
        <div className="min-w-0">
          <p className="font-semibold text-primary">#{task.posOrderId}</p>
          <p className="mt-1 text-sm text-[#678090]">{task.store?.tenantName ?? 'Client'}</p>
        </div>
      </td>
      <td className="px-5 py-4 text-sm text-primary">{task.customer.name ?? 'Unknown customer'}</td>
      <td className="px-5 py-4">
        <span className="font-mono text-[13px] font-semibold text-[#385164]">
          {task.tracking ?? 'No waybill'}
        </span>
      </td>
      <td className="px-5 py-4">
        <span className={buildStatusPill(returnSummary.state)}>
          {returnSummary.label ?? returnSummary.posStatusLabel ?? 'Not started'}
        </span>
      </td>
      <td className="px-5 py-4">
        <p className="text-sm font-semibold text-primary">
          {returnSummary.verifiedUnits}/{returnSummary.expectedUnits}
        </p>
        <p className="mt-1 text-xs text-[#708596]">
          {unitsCaption}
        </p>
      </td>
      <td className="px-5 py-4">
        <p className="text-sm font-semibold text-primary">
          {returnSummary.disposedBy?.name ?? returnSummary.disposedBy?.email ?? 'Pending'}
        </p>
        <p className="mt-1 text-xs text-[#708596]">
          {returnSummary.disposedAt ? `Done ${formatDateTime(returnSummary.disposedAt)}` : 'Not completed'}
        </p>
      </td>
      <td className="px-5 py-4 text-sm text-[#506879]">{task.store?.name ?? 'Unassigned'}</td>
      <td className="px-5 py-4 text-right">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
          className="btn btn-sm btn-outline"
        >
          View
        </button>
      </td>
    </tr>
  );
}

function EmptyState({
  colSpan,
  message,
}: {
  colSpan: number;
  message: string;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-5 py-10 text-sm text-[#6f8290]">
        {message}
      </td>
    </tr>
  );
}

function formatDate(value: string | null) {
  if (!value) {
    return 'N/A';
  }

  const nextDate = new Date(value);
  return Number.isNaN(nextDate.getTime()) ? value : DATE_FORMATTER.format(nextDate);
}

function formatDateTime(value: string | null) {
  if (!value) {
    return 'N/A';
  }

  const nextDate = new Date(value);
  return Number.isNaN(nextDate.getTime()) ? value : DATE_TIME_FORMATTER.format(nextDate);
}

function buildStatusPill(status: string | null | undefined) {
  switch (status) {
    case 'PACKED':
      return 'pill pill-info';
    case 'PACKED_CANCELED':
      return 'pill border-none bg-[#fff4db] text-[#a66313]';
    case 'SHIPPED':
      return 'pill pill-primary';
    case 'DELIVERED':
    case 'VERIFIED':
      return 'pill pill-success';
    case 'AWAITING_PLACEMENT':
    case 'RETURNING':
    case 'PARTIAL':
    case 'READY_TO_VERIFY':
      return 'pill border-none bg-[#fff4db] text-[#a66313]';
    case 'RETURNED':
    case 'CANCELED':
      return 'pill pill-destructive';
    default:
      return 'pill pill-neutral';
  }
}
