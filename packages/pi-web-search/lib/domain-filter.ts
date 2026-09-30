/**
 * Split a search `domainFilter` into the domains to keep and the domains to
 * drop. Entries starting with "-" are exclusions ("-pinterest.com").
 */
export function splitDomainFilter(filter: readonly string[] | undefined): {
  include: string[];
  exclude: string[];
} {
  const entries = filter ?? [];
  return {
    include: entries.filter((d) => !d.startsWith("-")),
    exclude: entries.filter((d) => d.startsWith("-")).map((d) => d.slice(1).trim()),
  };
}
