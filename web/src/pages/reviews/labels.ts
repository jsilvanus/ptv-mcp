import type {
  PreviewEntity,
  QualityReport,
  ReviewItem,
  ReviewItemStatus,
  ReviewTargetKind,
} from '../../api/types';

export const STATUS_LABELS: Record<ReviewItemStatus, string> = {
  open: 'To check',
  confirmed: 'Confirmed',
  changes_proposed: 'Changes proposed',
};

export const KIND_LABELS: Record<ReviewTargetKind, string> = {
  organisation: 'Organisation',
  service: 'Service',
  channel: 'Channel',
};

export interface ReviewItemDetails extends ReviewItem {
  current: PreviewEntity | null;
  quality: QualityReport | null;
}
