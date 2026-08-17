import { beforeAll, describe, expect, it } from 'vitest';
import { loadLanguages } from '../src/parse/treesitter/loader.js';
import { parseCSharpSource } from '../src/parse/csharp.js';
import { buildGraph } from '../src/graph/imports.js';
import { buildKnowledgeGraph } from '../src/graph/knowledge.js';

// Regression: the injected-interface shape. A controller calls a same-named service
// method through an injected INTERFACE (`_REGION.ValidateRegionCode()`), and the
// `using` directive names a project-root namespace that exists nowhere on
// disk. Before the fix this produced zero import edges and zero call edges —
// callers_of answered "no callers" and lost to grep.

beforeAll(async () => {
  await loadLanguages(['c_sharp']);
});

const CONTROLLER = `using System;
using AcmeApi.Services;

namespace AcmeApi.Controllers
{
    public class RegionController
    {
        private readonly IRegion _region;

        public string ValidateRegionCode(string creditId, string pincode)
        {
            return _region.ValidateRegionCode(long.Parse(creditId), long.Parse(pincode));
        }
    }
}
`;

const SERVICE = `using System;

namespace AcmeApi.Services
{
    public class Fsc : IRegion
    {
        public string ValidateRegionCode(long creditId, long pincode)
        {
            return "ok";
        }
    }
}
`;

const IFACE = `namespace AcmeApi.Services
{
    public interface IRegion
    {
        string ValidateRegionCode(long creditId, long pincode);
    }
}
`;

function parsedFiles() {
  return [
    parseCSharpSource('Controllers/RegionController.cs', 'Controllers', false, CONTROLLER),
    parseCSharpSource('Services/Fsc.cs', 'Services', false, SERVICE),
    parseCSharpSource('Services/IRegion.cs', 'Services', false, IFACE),
  ];
}

describe('C# namespace imports resolve to module directories', () => {
  it('using ProjectRoot.Services wires Controllers -> Services', () => {
    const graph = buildGraph(parsedFiles());
    expect([...(graph.imports.get('Controllers') ?? [])]).toContain('Services');
    expect([...(graph.importedBy.get('Services') ?? [])]).toContain('Controllers');
  });

  it('stdlib namespaces (System.*) never wire local edges', () => {
    const graph = buildGraph(parsedFiles());
    for (const tos of graph.imports.values()) {
      expect([...tos]).not.toContain('System');
    }
  });
});

describe('interface-dispatched calls resolve to call edges', () => {
  it('controller -> service impl AND interface, despite the same-named caller', () => {
    const files = parsedFiles();
    const graph = buildKnowledgeGraph(files, buildGraph(files), {});

    const idOf = (file: string) =>
      [...graph.nodes.values()].find((n) => n.kind === 'function' && n.file === file && n.label === 'ValidateRegionCode')?.id;
    const controller = idOf('Controllers/RegionController.cs')!;
    const impl = idOf('Services/Fsc.cs')!;
    const iface = idOf('Services/IRegion.cs')!;
    expect(controller).toBeDefined();
    expect(impl).toBeDefined();
    expect(iface).toBeDefined();

    // The dispatch cannot be narrowed statically: the graph over-approximates
    // with labeled 0.5 'module-scoped' edges to both candidates.
    expect([...(graph.callsIn.get(impl) ?? [])]).toContain(controller);
    expect([...(graph.callsIn.get(iface) ?? [])]).toContain(controller);
    expect(graph.callMeta.get(`${controller}|${impl}`)?.reason).toBe('module-scoped');
    // And it never self-links the controller to itself.
    expect([...(graph.callsIn.get(controller) ?? [])]).not.toContain(controller);
  });
});
