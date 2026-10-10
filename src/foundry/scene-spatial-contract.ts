import { z } from 'zod';
import {
  availableWorldReadMetadataSchema,
  documentIdSchema,
  paginationShape,
} from './read-contract.js';
import type { WorldActor, WorldData, WorldScene, WorldUser } from './types.js';

export const MAX_SPATIAL_SOURCE_RECORDS = 10_000;
const boundedName = z.string().max(512);
const finite = z.number().finite();

export const sceneSpatialInputSchema = z.strictObject({ sceneId: documentIdSchema.optional() });
export const sceneTokenListInputSchema = z.strictObject({
  sceneId: documentIdSchema.optional(),
  query: z.string().max(1024).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(1024).optional(),
});
export const sceneTokenInputSchema = z.strictObject({
  sceneId: documentIdSchema.optional(),
  tokenId: documentIdSchema,
});

export const sceneIdentitySchema = z.strictObject({
  id: documentIdSchema,
  uuid: z.string().regex(/^Scene\.[a-zA-Z0-9]{16}$/),
  name: boundedName,
  active: z.boolean(),
});
export const sceneSpatialRecordSchema = z.strictObject({
  id: documentIdSchema,
  uuid: z.string().regex(/^Scene\.[a-zA-Z0-9]{16}$/),
  name: boundedName,
  active: z.boolean(),
  source: z.strictObject({
    widthPixels: finite.positive(),
    heightPixels: finite.positive(),
    paddingRatio: finite.min(0).max(1),
    shiftXPixels: finite,
    shiftYPixels: finite,
  }),
  dimensions: z.strictObject({
    widthPixels: finite.positive(),
    heightPixels: finite.positive(),
    originXPixels: finite,
    originYPixels: finite,
    rows: z.number().int().nonnegative(),
    columns: z.number().int().nonnegative(),
    derivation: z.literal('foundry-native'),
  }),
  grid: z.strictObject({
    type: z.enum(['gridless', 'square', 'hex-odd-r', 'hex-even-r', 'hex-odd-q', 'hex-even-q']),
    sizePixels: finite.positive(),
    distance: finite.nonnegative().optional(),
    distanceUnits: z.string().max(128).optional(),
  }),
  units: z.strictObject({
    coordinates: z.literal('pixels'),
    dimensions: z.literal('pixels'),
    padding: z.literal('ratio'),
    gridSize: z.literal('pixels'),
    gridDistance: z.literal('scene-distance'),
  }),
});
export const sceneTokenSummarySchema = z.strictObject({
  id: documentIdSchema,
  uuid: z.string().regex(/^Scene\.[a-zA-Z0-9]{16}\.Token\.[a-zA-Z0-9]{16}$/),
  sceneId: documentIdSchema,
  sceneUuid: z.string().regex(/^Scene\.[a-zA-Z0-9]{16}$/),
  name: boundedName,
  xPixels: finite,
  yPixels: finite,
  widthGridSpaces: finite.positive(),
  heightGridSpaces: finite.positive(),
  rotationDegrees: finite,
  elevation: finite.optional(),
  elevationUnits: z.literal('scene-distance').optional(),
  hidden: z.boolean(),
  actor: z
    .strictObject({
      id: documentIdSchema,
      uuid: z.string().regex(/^Actor\.[a-zA-Z0-9]{16}$/),
      name: boundedName,
      type: z.string().max(128),
      linked: z.boolean(),
    })
    .optional(),
  units: z.strictObject({
    position: z.literal('pixels'),
    footprint: z.literal('grid-spaces'),
    rotation: z.literal('degrees'),
    elevation: z.literal('scene-distance'),
  }),
});
export const sceneTokenDetailSchema = sceneTokenSummarySchema.extend({
  texture: z
    .strictObject({
      src: z.string().max(2048).optional(),
      scaleX: finite.optional(),
      scaleY: finite.optional(),
    })
    .optional(),
});
export const sceneSpatialOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('Scene'),
  scene: sceneSpatialRecordSchema,
  readMetadata: availableWorldReadMetadataSchema,
});
export const sceneTokenListOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('Token'),
  scene: sceneIdentitySchema,
  records: z.array(sceneTokenSummarySchema).max(100),
  ...paginationShape,
});
export const sceneTokenOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  documentType: z.literal('Token'),
  scene: sceneIdentitySchema,
  token: sceneTokenDetailSchema,
  readMetadata: availableWorldReadMetadataSchema,
});

export const sceneSpatialInputJsonSchema = z.toJSONSchema(sceneSpatialInputSchema, {
  target: 'draft-7',
});
export const sceneTokenListInputJsonSchema = z.toJSONSchema(sceneTokenListInputSchema, {
  target: 'draft-7',
});
export const sceneTokenInputJsonSchema = z.toJSONSchema(sceneTokenInputSchema, {
  target: 'draft-7',
});
export const sceneSpatialOutputJsonSchema = z.toJSONSchema(sceneSpatialOutputSchema, {
  target: 'draft-7',
});
export const sceneTokenListOutputJsonSchema = z.toJSONSchema(sceneTokenListOutputSchema, {
  target: 'draft-7',
});
export const sceneTokenOutputJsonSchema = z.toJSONSchema(sceneTokenOutputSchema, {
  target: 'draft-7',
});

export type SceneIdentity = z.infer<typeof sceneIdentitySchema>;
export type SceneSpatialRecord = z.infer<typeof sceneSpatialRecordSchema>;
export type SceneTokenSummary = z.infer<typeof sceneTokenSummarySchema>;
export type SceneTokenDetail = z.infer<typeof sceneTokenDetailSchema>;
export type SceneSpatialOutput = z.infer<typeof sceneSpatialOutputSchema>;
export type SceneTokenListOutput = z.infer<typeof sceneTokenListOutputSchema>;
export type SceneTokenOutput = z.infer<typeof sceneTokenOutputSchema>;

export interface SceneSpatialProjection {
  readonly scenes: readonly {
    readonly scene: SceneSpatialRecord;
    readonly tokens: readonly SceneTokenDetail[];
  }[];
}

const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9]{16}$/.test(v);
const validText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max;
const validFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function level(ownership: unknown, userId: string): number | undefined {
  if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)) {
    return undefined;
  }
  const o = ownership as Record<string, unknown>;
  if (
    Object.keys(o).some((key) => key.length === 0) ||
    Object.values(o).some((v) => !Number.isInteger(v) || (v as number) < -1 || (v as number) > 3)
  ) {
    return undefined;
  }
  const own = o[userId];
  const fallback = o.default;
  return typeof own === 'number' && own !== -1
    ? own
    : typeof fallback === 'number' && fallback !== -1
      ? fallback
      : 0;
}
function observable(ownership: unknown, user: WorldUser): boolean {
  const permission = level(ownership, user._id);
  return permission !== undefined && (user.role >= 3 || permission >= 2);
}

function dimensions(
  width: number,
  height: number,
  padding: number,
  size: number,
  type: number,
  shiftX: number,
  shiftY: number,
) {
  if (type === 0) {
    const x = Math.ceil(padding * width * (1 / size)) * size;
    const y = Math.ceil(padding * height * (1 / size)) * size;
    const w = width + 2 * x;
    const h = height + 2 * y;
    return {
      widthPixels: w,
      heightPixels: h,
      originXPixels: x - shiftX,
      originYPixels: y - shiftY,
      rows: Math.ceil(h),
      columns: Math.ceil(w),
      derivation: 'foundry-native' as const,
    };
  }
  if (type === 1) {
    const unit = size;
    const x = Math.ceil(padding * width * (1 / unit)) * unit,
      y = Math.ceil(padding * height * (1 / unit)) * unit;
    const w = width + 2 * x,
      h = height + 2 * y;
    return {
      widthPixels: w,
      heightPixels: h,
      originXPixels: x - shiftX,
      originYPixels: y - shiftY,
      rows: Math.ceil(h / unit - 1e-6),
      columns: Math.ceil(w / unit - 1e-6),
      derivation: 'foundry-native' as const,
    };
  }
  const columns = type === 4 || type === 5;
  const sizeX = columns ? (2 * size) / Math.sqrt(3) : size,
    sizeY = columns ? size : (2 * size) / Math.sqrt(3);
  const strideX = columns ? 0.75 * sizeX : sizeX,
    strideY = columns ? sizeY : 0.75 * sizeY;
  if (padding === 0) {
    const cols = Math.ceil((width + (columns ? -sizeX / 4 : sizeX / 2)) / strideX - 1e-6);
    const rows = Math.ceil((height + (columns ? sizeY / 2 : -sizeY / 4)) / strideY - 1e-6);
    return {
      widthPixels: width,
      heightPixels: height,
      originXPixels: -shiftX,
      originYPixels: -shiftY,
      rows,
      columns: cols,
      derivation: 'foundry-native' as const,
    };
  }
  let x = Math.ceil((padding * width) / strideX) * strideX,
    y = Math.ceil((padding * height) / strideY) * strideY;
  let w = width + 2 * Math.round(Math.ceil((padding * width) / strideX) * strideX),
    h = height + 2 * Math.round(Math.ceil((padding * height) / strideY) * strideY);
  const crossing = Math.round(columns ? x / strideX : y / strideY) % 2 === 0;
  if (!crossing) {
    if (columns) {
      y += sizeY / 2;
      h += sizeY;
    } else {
      x += sizeX / 2;
      w += sizeX;
    }
  }
  let cols = Math.round(w / strideX),
    rows = Math.round(h / strideY);
  w = cols * strideX;
  h = rows * strideY;
  if (columns) {
    rows++;
    w += sizeX / 4;
  } else {
    cols++;
    h += sizeY / 4;
  }
  return {
    widthPixels: w,
    heightPixels: h,
    originXPixels: x - shiftX,
    originYPixels: y - shiftY,
    rows,
    columns: cols,
    derivation: 'foundry-native' as const,
  };
}

function publicActor(
  token: Record<string, unknown>,
  actors: Map<string, WorldActor>,
  user: WorldUser,
) {
  const actorId = token.actorId;
  if (actorId === undefined || actorId === null || actorId === '') {
    return { ok: true as const };
  }
  if (!validId(actorId)) {
    return { ok: false as const };
  }
  const actor = actors.get(actorId);
  if (!actor) {
    return { ok: false as const };
  }
  if (!validText(actor.name, 512) || !validText(actor.type, 128)) {
    return { ok: false as const };
  }
  const linked = token.actorLink === true;
  if (token.actorLink !== true && token.actorLink !== false) {
    return { ok: false as const };
  }
  let name = actor.name,
    type = actor.type;
  let ownership: unknown = actor.ownership;
  if (!linked && token.delta !== undefined && token.delta !== null) {
    if (typeof token.delta !== 'object' || Array.isArray(token.delta)) {
      return { ok: false as const };
    }
    const d = token.delta as Record<string, unknown>;
    if (d.ownership !== undefined && d.ownership !== null) {
      if (
        !ownership ||
        typeof ownership !== 'object' ||
        Array.isArray(ownership) ||
        !d.ownership ||
        typeof d.ownership !== 'object' ||
        Array.isArray(d.ownership)
      ) {
        return { ok: false as const };
      }
      ownership = {
        ...(ownership as Record<string, unknown>),
        ...(d.ownership as Record<string, unknown>),
      };
    }
    if (d.name !== undefined && d.name !== null) {
      if (!validText(d.name, 512)) {
        return { ok: false as const };
      }
      name = d.name;
    }
    if (d.type !== undefined && d.type !== null) {
      if (!validText(d.type, 128)) {
        return { ok: false as const };
      }
      type = d.type;
    }
  }
  if (!observable(ownership, user)) {
    return { ok: false as const };
  }
  return {
    ok: true as const,
    actor: { id: actorId, uuid: `Actor.${actorId}`, name, type, linked },
  };
}

function projectToken(
  raw: Record<string, unknown>,
  sceneId: string,
  actors: Map<string, WorldActor>,
  user: WorldUser,
): SceneTokenDetail | undefined {
  if (
    !validId(raw._id) ||
    !validText(raw.name, 512) ||
    !validFinite(raw.x) ||
    !validFinite(raw.y) ||
    !validFinite(raw.width) ||
    raw.width <= 0 ||
    !validFinite(raw.height) ||
    raw.height <= 0 ||
    !validFinite(raw.rotation) ||
    typeof raw.hidden !== 'boolean'
  ) {
    return undefined;
  }
  if (raw.hidden && user.role < 3) {
    return undefined;
  }
  const a = publicActor(raw, actors, user);
  if (!a.ok) {
    return undefined;
  }
  const t = raw.texture;
  let texture: SceneTokenDetail['texture'];
  if (t !== undefined && t !== null) {
    if (typeof t !== 'object' || Array.isArray(t)) {
      return undefined;
    }
    const o = t as Record<string, unknown>;
    texture = {};
    if (o.src !== undefined) {
      if (!validText(o.src, 2048)) {
        return undefined;
      }
      texture.src = o.src;
    }
    if (o.scaleX !== undefined) {
      if (!validFinite(o.scaleX)) {
        return undefined;
      }
      texture.scaleX = o.scaleX;
    }
    if (o.scaleY !== undefined) {
      if (!validFinite(o.scaleY)) {
        return undefined;
      }
      texture.scaleY = o.scaleY;
    }
  }
  const token: SceneTokenDetail = {
    id: raw._id,
    uuid: `Scene.${sceneId}.Token.${raw._id}`,
    sceneId,
    sceneUuid: `Scene.${sceneId}`,
    name: raw.name,
    xPixels: raw.x,
    yPixels: raw.y,
    widthGridSpaces: raw.width,
    heightGridSpaces: raw.height,
    rotationDegrees: raw.rotation,
    hidden: raw.hidden,
    units: {
      position: 'pixels',
      footprint: 'grid-spaces',
      rotation: 'degrees',
      elevation: 'scene-distance',
    },
  };
  if (validFinite(raw.elevation)) {
    token.elevation = raw.elevation;
    token.elevationUnits = 'scene-distance';
  } else if (raw.elevation !== undefined && raw.elevation !== null) {
    return undefined;
  }
  if (a.actor) {
    token.actor = a.actor;
  }
  if (texture) {
    token.texture = texture;
  }
  return token;
}

function projectScene(raw: WorldScene, actors: Map<string, WorldActor>, user: WorldUser) {
  if (
    !observable(raw.ownership, user) ||
    !validId(raw._id) ||
    !validText(raw.name, 512) ||
    typeof raw.active !== 'boolean' ||
    !validFinite(raw.width) ||
    raw.width <= 0 ||
    !validFinite(raw.height) ||
    raw.height <= 0 ||
    !validFinite(raw.padding) ||
    raw.padding < 0 ||
    raw.padding > 1
  ) {
    return undefined;
  }
  const sx = (raw as unknown as Record<string, unknown>).shiftX ?? 0,
    sy = (raw as unknown as Record<string, unknown>).shiftY ?? 0;
  if (!validFinite(sx) || !validFinite(sy)) {
    return undefined;
  }
  const g = raw.grid;
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    return undefined;
  }
  const type = g.type,
    size = g.size;
  if (
    typeof type !== 'number' ||
    !Number.isInteger(type) ||
    type < 0 ||
    type > 5 ||
    !validFinite(size) ||
    size <= 0
  ) {
    return undefined;
  }
  const types = [
    'gridless',
    'square',
    'hex-odd-r',
    'hex-even-r',
    'hex-odd-q',
    'hex-even-q',
  ] as const;
  const gridType = types[type as 0 | 1 | 2 | 3 | 4 | 5];
  const grid: SceneSpatialRecord['grid'] = { type: gridType, sizePixels: size };
  if (g.distance !== undefined) {
    if (!validFinite(g.distance) || g.distance < 0) {
      return undefined;
    }
    grid.distance = g.distance;
  }
  if (g.units !== undefined) {
    if (!validText(g.units, 128)) {
      return undefined;
    }
    grid.distanceUnits = g.units;
  }
  const scene: SceneSpatialRecord = {
    id: raw._id,
    uuid: `Scene.${raw._id}`,
    name: raw.name,
    active: raw.active,
    source: {
      widthPixels: raw.width,
      heightPixels: raw.height,
      paddingRatio: raw.padding,
      shiftXPixels: sx,
      shiftYPixels: sy,
    },
    dimensions: dimensions(raw.width, raw.height, raw.padding, size, type as number, sx, sy),
    grid,
    units: {
      coordinates: 'pixels',
      dimensions: 'pixels',
      padding: 'ratio',
      gridSize: 'pixels',
      gridDistance: 'scene-distance',
    },
  };
  if (!Array.isArray(raw.tokens) || raw.tokens.length > MAX_SPATIAL_SOURCE_RECORDS) {
    return undefined;
  }
  const tokens = raw.tokens
    .map((t) => projectToken(t, raw._id, actors, user))
    .filter((t): t is SceneTokenDetail => !!t);
  return { scene, tokens };
}

export function projectSceneSpatial(source: WorldData, user: WorldUser): SceneSpatialProjection {
  if (
    source.scenes.length > MAX_SPATIAL_SOURCE_RECORDS ||
    source.actors.length > MAX_SPATIAL_SOURCE_RECORDS
  ) {
    throw new Error('Scene spatial source exceeds the supported limit');
  }
  const actors = new Map(source.actors.filter((a) => validId(a._id)).map((a) => [a._id, a]));
  return {
    scenes: source.scenes
      .map((s) => projectScene(s, actors, user))
      .filter((s): s is NonNullable<ReturnType<typeof projectScene>> => !!s),
  };
}
