import { Room } from 'matrix-js-sdk';
import { Editor } from 'slate';
import { IReplyDraft } from '../../state/room/roomInputDrafts';

export type MobileSwipeReplyBridge = {
  room: Room;
  editor: Editor;
  setReplyDraft: (draft: IReplyDraft | undefined) => void;
  layerEl: HTMLElement | null;
  setIndicator: (top: number | null, active: boolean) => void;
};

export const mobileSwipeReplyBridgeRef: { current: MobileSwipeReplyBridge | null } = {
  current: null,
};
