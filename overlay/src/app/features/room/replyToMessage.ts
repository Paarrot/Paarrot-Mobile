import { RelationType, Room } from 'matrix-js-sdk';
import { Editor } from 'slate';
import { ReactEditor } from 'slate-react';
import { getEditedEvent } from '../../utils/room';
import { IReplyDraft } from '../../state/room/roomInputDrafts';

export const startReplyToEvent = (
  room: Room,
  eventId: string,
  setReplyDraft: (draft: IReplyDraft | undefined) => void,
  editor?: Editor,
  startThread = false
): boolean => {
  const replyEvt = room.findEventById(eventId);
  if (!replyEvt || replyEvt.isRedacted()) return false;

  const editedReply = getEditedEvent(eventId, replyEvt, room.getUnfilteredTimelineSet());
  const content = editedReply?.getContent()['m.new_content'] ?? replyEvt.getContent();
  const { body, formatted_body: formattedBody } = content;
  const senderId = replyEvt.getSender();

  if (!senderId || typeof body !== 'string') return false;

  const relation = startThread
    ? { rel_type: RelationType.Thread, event_id: eventId }
    : replyEvt.getWireContent()['m.relates_to'];

  setReplyDraft({
    userId: senderId,
    eventId,
    body,
    formattedBody,
    relation,
  });

  if (editor) {
    setTimeout(() => ReactEditor.focus(editor), 100);
  }

  return true;
};
