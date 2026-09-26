import type { Connection } from '../../domain.js';
import { localized, modifiedAtOf } from './common.js';

export function mapV12Connection(wire: unknown): Connection {
  const value = (wire && typeof wire === 'object' ? wire : {}) as Record<string, unknown>;
  const service = value.service as Record<string, unknown> | undefined;
  const channel = value.channel as Record<string, unknown> | undefined;
  const serviceId =
    value.serviceContentId ?? value.serviceId ?? service?.contentId ?? service?.id ?? '';
  const channelId =
    value.channelContentId ??
    value.channelId ??
    value.serviceChannelId ??
    channel?.contentId ??
    channel?.id ??
    '';
  if (!serviceId || !channelId)
    throw new Error('PTV v12 connection response has no service/channel id');
  const descriptions = localized(value.languageVersions, 'description');
  const timestamp = value.modifiedAt ?? value.publishedAt;
  const modifiedAt = modifiedAtOf(typeof timestamp === 'string' ? { modifiedAt: timestamp } : {});
  return {
    serviceId: String(serviceId),
    channelId: String(channelId),
    ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
  };
}
