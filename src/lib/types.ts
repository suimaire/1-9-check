// DB 행 모양(시각은 ISO 문자열, 날짜는 'YYYY-MM-DD')

export type Role = 'teacher' | 'student';

export interface Me {
  userId: string;
  role: Role;
  displayName: string;
  mustChangePassword: boolean;
}

export interface ClassInfo {
  id: string;
  name: string;
  app_title: string;
  app_subtitle: string;
}

export interface Term {
  id: string;
  class_id: string;
  name: string;
  start_date: string;
  last_record_date: string;
  deadline_minutes: number;
  final_close_at: string;
  retention_until: string | null;
  instructions: string;
}

export interface TermDay {
  term_id: string;
  record_date: string;
  is_target: boolean;
  window_open_at: string;
  deadline_at: string;
  note: string | null;
}

export interface Student {
  id: string;
  class_id: string;
  student_no: string;
  /** 표시명(교사 화면 전용). 공개 제출 화면에는 반환·표시하지 않는다. */
  name: string;
  active: boolean;
  roster_from: string | null;
  roster_until: string | null;
}

export type ReviewStatus = 'unchecked' | 'checked' | 'revision_requested';

/** 사진 세트의 사진 1장(현재 버전). 사진 순서는 1~3. */
export interface SubmissionImage {
  path: string;
  mime: string;
  bytes: number;
  sort_order: number;
}

/** 하루 사진 수 상한 */
export const MAX_IMAGES = 3;

export interface Submission {
  id: string;
  term_id: string;
  student_id: string;
  record_date: string;
  image_path: string;
  image_version: number;
  image_mime: string;
  image_bytes: number;
  first_submitted_at: string;
  image_updated_at: string;
  self_minutes: number | null;
  student_note: string | null;
  review_status: ReviewStatus;
  reviewed_version: number | null;
  revision_message: string | null;
  reviewed_at: string | null;
  /** 담임이 '다른 기기 재제출 허용'을 켠 상태(token 없이 한 번 교체 가능) */
  resubmit_open: boolean;
  /**
   * 현재 버전의 사진 세트(1~3장, 순서대로). submission_images 행이 없던 예전 제출은
   * image_path 1장으로 채운다. image_path·image_mime·image_bytes는 1번 사진 값(호환용).
   */
  images: SubmissionImage[];
}

export type ExcuseReason = 'no_device' | 'device_unavailable' | 'no_record' | 'other';

export interface Excuse {
  id: string;
  term_id: string;
  student_id: string;
  record_date: string;
  reason: ExcuseReason;
  note: string | null;
  status: 'pending' | 'approved' | 'declined';
  created_at: string;
  updated_at: string;
}

export interface Exemption {
  term_id: string;
  student_id: string;
  record_date: string;
  reason: string | null;
}

export interface TeacherNote {
  id: string;
  term_id: string;
  student_id: string;
  record_date: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export const EXCUSE_LABEL: Record<ExcuseReason, string> = {
  no_device: '스마트폰이 없어요',
  device_unavailable: '기기 고장·보관 중',
  no_record: '사용 기록이 안 보여요',
  other: '기타',
};

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  unchecked: '미확인',
  checked: '확인 완료',
  revision_requested: '수정 요청',
};
