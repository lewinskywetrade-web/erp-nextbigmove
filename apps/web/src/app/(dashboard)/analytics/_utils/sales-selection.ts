/** Keep an explicit empty selection distinct from the endpoint's default All. */
export function buildSalesMappingSelection(all: boolean, selected: string[]) {
  const mappings = all ? [] : [...new Set(selected)].sort();
  const emptySelection = !all && mappings.length === 0;
  return {
    key: all ? '__all__' : emptySelection ? '__none__' : JSON.stringify(mappings),
    mappings,
    emptySelection,
  };
}

/** Match api-client's header source exactly, including an explicitly empty list. */
export function parseSalesTeamSelection(multiple: string | null, single: string | null): string[] {
  if (multiple) {
    try {
      const parsed = JSON.parse(multiple);
      const values: unknown[] = Array.isArray(parsed) ? parsed : [];
      return [...new Set(values.filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
    } catch { return []; }
  }
  return single && single !== 'ALL_TEAMS' ? [single] : [];
}
