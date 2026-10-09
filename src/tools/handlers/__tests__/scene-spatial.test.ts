import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { PaginationCursorError } from '../../../foundry/pagination.js';
import { getAllTools } from '../../definitions.js';
import {
  handleGetSceneInfo,
  handleGetSceneSpatial,
  handleGetSceneToken,
  handleListSceneTokens,
} from '../scenes.js';
import { paginationMetadata, readMetadata } from './pagination-fixture.js';

const SCENE = 'Scene00000000001';

function scene() {
  return {
    id: SCENE,
    uuid: `Scene.${SCENE}`,
    name: 'Large Encounter',
    active: true,
  } as const;
}

function token(index: number, large = false) {
  const id = `Token${String(index).padStart(11, '0')}`;
  const actorId = `Actor${String(index).padStart(11, '0')}`;
  return {
    id,
    uuid: `Scene.${SCENE}.Token.${id}`,
    sceneId: SCENE,
    sceneUuid: `Scene.${SCENE}`,
    name: large ? 'é'.repeat(512) : `Token ${index}`,
    xPixels: -index,
    yPixels: index,
    widthGridSpaces: 1,
    heightGridSpaces: 2,
    rotationDegrees: 0,
    elevation: 0,
    elevationUnits: 'scene-distance' as const,
    hidden: false,
    actor: {
      id: actorId,
      uuid: `Actor.${actorId}`,
      name: large ? 'é'.repeat(512) : `Actor ${index}`,
      type: large ? 'x'.repeat(128) : 'npc',
      linked: index % 2 === 0,
    },
    units: {
      position: 'pixels' as const,
      footprint: 'grid-spaces' as const,
      rotation: 'degrees' as const,
      elevation: 'scene-distance' as const,
    },
  };
}

function spatialOutput() {
  return {
    schemaVersion: 1 as const,
    documentType: 'Scene' as const,
    scene: {
      ...scene(),
      source: {
        widthPixels: 1234,
        heightPixels: 987,
        paddingRatio: 0.2,
        shiftXPixels: 30,
        shiftYPixels: -25,
      },
      dimensions: {
        widthPixels: 1834,
        heightPixels: 1387,
        originXPixels: 270,
        originYPixels: 225,
        rows: 14,
        columns: 19,
        derivation: 'foundry-native' as const,
      },
      grid: { type: 'square' as const, sizePixels: 100, distance: 5, distanceUnits: 'ft' },
      units: {
        coordinates: 'pixels' as const,
        dimensions: 'pixels' as const,
        padding: 'ratio' as const,
        gridSize: 'pixels' as const,
        gridDistance: 'scene-distance' as const,
      },
    },
    readMetadata: readMetadata(),
  };
}

function client(methods: Record<string, unknown>, delegated = false): FoundryClient {
  return {
    isDelegatedMode: () => delegated,
    ...methods,
  } as unknown as FoundryClient;
}

describe('scene spatial MCP handlers', () => {
  it('publishes strict input and output schemas for all three tools', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const tools = getAllTools();
    const spatial = tools.find((tool) => tool.name === 'get_scene_spatial');
    const list = tools.find((tool) => tool.name === 'list_scene_tokens');
    const detail = tools.find((tool) => tool.name === 'get_scene_token');
    expect(spatial?.outputSchema).toBeDefined();
    expect(list?.outputSchema).toBeDefined();
    expect(detail?.outputSchema).toBeDefined();
    if (!spatial?.outputSchema || !list?.outputSchema || !detail?.outputSchema) {
      throw new Error('expected scene spatial tool output schemas');
    }
    expect(ajv.validate(spatial.outputSchema, spatialOutput())).toBe(true);

    const records = [token(0)];
    const page = {
      schemaVersion: 1,
      documentType: 'Token',
      scene: scene(),
      records,
      ...paginationMetadata(1, 1, 100),
    };
    expect(ajv.validate(list.outputSchema, page)).toBe(true);
    expect(ajv.validate(list.outputSchema, { ...page, unexpected: true })).toBe(false);
    expect(
      ajv.validate(list.outputSchema, {
        ...page,
        records: [{ ...records[0], texture: { src: 'private.webp' } }],
      }),
    ).toBe(false);
    expect(
      ajv.validate(detail.outputSchema, {
        schemaVersion: 1,
        documentType: 'Token',
        scene: scene(),
        token: { ...records[0], texture: { src: 'visible.webp', scaleX: 0, scaleY: 4 } },
        readMetadata: readMetadata(),
      }),
    ).toBe(true);
  });

  it('returns compact text and keeps a realistic 100-record page below 128 KiB', async () => {
    const records = Array.from({ length: 100 }, (_, index) => token(index));
    const fetch = vi.fn(() => ({
      schemaVersion: 1 as const,
      documentType: 'Token' as const,
      scene: scene(),
      records,
      ...paginationMetadata(100, 100, 100),
    }));
    const result = await handleListSceneTokens({ limit: 100 }, client({ listSceneTokens: fetch }));
    expect(fetch).toHaveBeenCalledExactlyOnceWith({ limit: 100 });
    expect(result.content[0]?.text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent.records).toHaveLength(100);
    expect(result.structuredContent.records.every((record) => !('texture' in record))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(128 * 1024);
  });

  it('validates requests before lookup and rejects malformed or oversized output', async () => {
    const list = vi.fn();
    await expect(
      handleListSceneTokens({ limit: 101, extra: true }, client({ listSceneTokens: list })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(list).not.toHaveBeenCalled();

    await expect(
      handleGetSceneToken({ tokenId: '../escape' }, client({ getSceneToken: vi.fn() })),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    await expect(
      handleListSceneTokens(
        { limit: 100 },
        client({
          listSceneTokens: () => ({
            schemaVersion: 1,
            documentType: 'Token',
            scene: scene(),
            records: Array.from({ length: 100 }, (_, index) => token(index, true)),
            ...paginationMetadata(100, 100, 100),
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining('request a smaller limit'),
    });
  });

  it('serves spatial and token detail envelopes and hides delegated cursor details', async () => {
    const spatial = await handleGetSceneSpatial(
      {},
      client({ getSceneSpatial: vi.fn(() => spatialOutput()) }),
    );
    const spatialText = spatial.content[0]?.text;
    if (spatialText === undefined) {
      throw new Error('expected textual scene spatial response');
    }
    expect(JSON.parse(spatialText)).toEqual(spatial.structuredContent);

    const detailRecord = { ...token(0), texture: { src: '', scaleX: 0, scaleY: -2 } };
    const detail = await handleGetSceneToken(
      { tokenId: detailRecord.id },
      client({
        getSceneToken: vi.fn(() => ({
          schemaVersion: 1,
          documentType: 'Token',
          scene: scene(),
          token: detailRecord,
          readMetadata: readMetadata(),
        })),
      }),
    );
    expect(detail.structuredContent.token.texture).toEqual({ src: '', scaleX: 0, scaleY: -2 });

    await expect(
      handleListSceneTokens(
        { cursor: 'opaque' },
        client(
          {
            listSceneTokens: () => {
              throw new PaginationCursorError('signature revealed');
            },
          },
          true,
        ),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('Pagination cursor unavailable'),
    });
  });

  it('forwards every optional list filter and preserves local cursor diagnostics', async () => {
    const list = vi.fn(() => ({
      schemaVersion: 1 as const,
      documentType: 'Token' as const,
      scene: scene(),
      records: [token(0)],
      ...paginationMetadata(1, 1, 1),
    }));
    await handleListSceneTokens(
      { sceneId: SCENE, query: 'goblin', limit: 1, cursor: 'opaque' },
      client({ listSceneTokens: list }),
    );
    expect(list).toHaveBeenCalledExactlyOnceWith({
      sceneId: SCENE,
      query: 'goblin',
      limit: 1,
      cursor: 'opaque',
    });

    await expect(
      handleListSceneTokens(
        {},
        client({
          listSceneTokens: () => {
            throw new PaginationCursorError('cursor query mismatch');
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining('cursor query mismatch'),
    });
  });

  it('retains legacy scene summaries for present and absent display values', async () => {
    const getCurrentScene = vi
      .fn()
      .mockResolvedValueOnce({
        _id: SCENE,
        name: 'Illuminated',
        active: true,
        navigation: true,
        width: 1000,
        height: 800,
        padding: 0,
        globalLight: true,
        darkness: 0,
        description: 'Visible description',
      })
      .mockResolvedValueOnce({
        _id: SCENE,
        name: 'Dark',
        active: false,
        navigation: false,
        width: 1000,
        height: 800,
        padding: 0.25,
        globalLight: false,
        darkness: 1,
        description: '',
      });
    const foundry = client({ getCurrentScene, getReadMetadata: () => readMetadata() });
    const present = await handleGetSceneInfo({ sceneId: SCENE }, foundry);
    const absent = await handleGetSceneInfo({}, foundry);
    expect(getCurrentScene).toHaveBeenNthCalledWith(1, SCENE);
    expect(getCurrentScene).toHaveBeenNthCalledWith(2, undefined);
    expect(present.content[0]?.text).toContain('**Active:** Yes');
    expect(present.content[0]?.text).toContain('**Navigation:** Enabled');
    expect(present.content[0]?.text).toContain('**Global Light:** Enabled');
    expect(present.content[0]?.text).toContain('Visible description');
    expect(absent.content[0]?.text).toContain('**Active:** No');
    expect(absent.content[0]?.text).toContain('**Navigation:** Disabled');
    expect(absent.content[0]?.text).toContain('**Global Light:** Disabled');
    expect(absent.content[0]?.text).toContain('No description available.');
  });
});
