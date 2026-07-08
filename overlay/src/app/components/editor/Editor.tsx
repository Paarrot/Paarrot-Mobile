/* eslint-disable no-param-reassign */
import React, {
  ClipboardEventHandler,
  KeyboardEventHandler,
  ReactNode,
  forwardRef,
  useCallback,
  useState,
  useEffect,
  useRef,
} from 'react';
import { Box, Scroll, Text } from 'folds';
import { Descendant, Editor, createEditor, Transforms, Range, Element as SlateElement, Text as SlateText, Point } from 'slate';
import {
  Slate,
  Editable,
  withReact,
  RenderLeafProps,
  RenderElementProps,
  RenderPlaceholderProps,
  ReactEditor,
} from 'slate-react';
import { withHistory } from 'slate-history';
import { BlockType } from './types';
import { RenderElement, RenderLeaf } from './Elements';
import { CustomElement } from './slate';
import * as css from './Editor.css';
import { toggleKeyboardShortcut } from './keyboard';
import { createCommandElement } from './utils';

const initialValue: CustomElement[] = [
  {
    type: BlockType.Paragraph,
    children: [{ text: '' }],
  },
];

const withInline = (editor: Editor): Editor => {
  const { isInline } = editor;

  editor.isInline = (element) =>
    [BlockType.Mention, BlockType.Emoticon, BlockType.Link, BlockType.Command].includes(
      element.type
    ) || isInline(element);

  return editor;
};

const withVoid = (editor: Editor): Editor => {
  const { isVoid } = editor;

  editor.isVoid = (element) =>
    [BlockType.Mention, BlockType.Emoticon, BlockType.Command].includes(element.type) ||
    isVoid(element);

  return editor;
};

type CommandValidatorFn = (commandName: string) => boolean;

let commandValidator: CommandValidatorFn | null = null;

export const setCommandValidator = (validator: CommandValidatorFn) => {
  commandValidator = validator;
};

const withCommandAutoConvert = (editor: Editor): Editor => {
  // Removed auto-conversion on space to prevent focus issues
  // Commands are now highlighted visually via decorations
  // and executed when Enter is pressed
  return editor;
};

export const useEditor = (): Editor => {
  const [editor] = useState(() => 
    withCommandAutoConvert(withInline(withVoid(withReact(withHistory(createEditor())))))
  );
  return editor;
};

export type EditorChangeHandler = (value: Descendant[]) => void;
type CustomEditorProps = {
  editableName?: string;
  top?: ReactNode;
  bottom?: ReactNode;
  before?: ReactNode;
  after?: ReactNode;
  maxHeight?: string;
  editor: Editor;
  placeholder?: string;
  onKeyDown?: KeyboardEventHandler;
  onKeyUp?: KeyboardEventHandler;
  onChange?: EditorChangeHandler;
  onPaste?: ClipboardEventHandler;
};
export const CustomEditor = forwardRef<HTMLDivElement, CustomEditorProps>(
  (
    {
      editableName,
      top,
      bottom,
      before,
      after,
      maxHeight = '50vh',
      editor,
      placeholder,
      onKeyDown,
      onKeyUp,
      onChange,
      onPaste,
    },
    ref
  ) => {
    const renderElement = useCallback(
      (props: RenderElementProps) => <RenderElement {...props} />,
      []
    );

    const renderLeaf = useCallback((props: RenderLeafProps) => <RenderLeaf {...props} />, []);

    const decorate = useCallback(([node, path]: [any, number[]]) => {
      const ranges: any[] = [];
      
      // Only decorate text nodes in the first paragraph
      if (
        path.length === 2 &&
        path[0] === 0 &&
        path[1] === 0 &&
        SlateText.isText(node)
      ) {
        const firstChild = editor.children[0];
        
        if (SlateElement.isElement(firstChild) && firstChild.type === BlockType.Paragraph) {
          const [firstInline, secondInline] = firstChild.children;
          
          // Don't decorate if we already have a CommandElement
          if (SlateElement.isElement(secondInline) && secondInline.type === BlockType.Command) {
            return ranges;
          }
          
          // Check if the text matches /command pattern
          const text = node.text;
          const match = text.match(/^(\s*\/\w+)/);
          
          if (match && commandValidator) {
            const commandText = match[1].trim();
            const commandName = commandText.substring(1);
            
            if (commandValidator(commandName)) {
              // Create decoration for the command text
              ranges.push({
                anchor: { path, offset: 0 },
                focus: { path, offset: match[1].length },
                pendingCommand: true,
              });
            }
          }
        }
      }
      
      return ranges;
    }, [editor]);

    const handleKeydown: KeyboardEventHandler = useCallback(
      (evt) => {
        onKeyDown?.(evt);
        const shortcutToggled = toggleKeyboardShortcut(editor, evt);
        if (shortcutToggled) evt.preventDefault();
      },
      [editor, onKeyDown]
    );

    const handleBeforeInput = useCallback(
      (event: Event) => {
        const inputEvent = event as InputEvent;

        // Handle mobile autocorrect replacement that causes text duplication in Slate
        if (inputEvent.inputType === 'insertReplacementText') {
          const data = inputEvent.data || inputEvent.dataTransfer?.getData('text/plain');
          if (!data) return;

          event.preventDefault();

          const domRanges = inputEvent.getTargetRanges?.() ?? [];
          if (domRanges.length > 0) {
            const slateRange = ReactEditor.toSlateRange(editor, domRanges[0], {
              exactMatch: false,
              suppressThrow: true,
            });

            if (slateRange) {
              Transforms.select(editor, slateRange);
              Transforms.delete(editor);
              editor.insertText(data);
              return;
            }
          }

          const { selection } = editor;
          if (!selection) return;

          if (!Range.isCollapsed(selection)) {
            Transforms.delete(editor, { at: selection });
          } else {
            const wordBefore = Editor.before(editor, selection.anchor, { unit: 'word' });
            if (wordBefore) {
              const wordRange = { anchor: wordBefore, focus: selection.anchor };
              Transforms.select(editor, wordRange);
              Transforms.delete(editor);
            }
          }

          editor.insertText(data);
        }
      },
      [editor]
    );

    const editableRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const editableElement = editableRef.current?.querySelector('[data-slate-editor="true"]');
      if (!editableElement) return;

      editableElement.addEventListener('beforeinput', handleBeforeInput, { capture: true });
      
      return () => {
        editableElement.removeEventListener('beforeinput', handleBeforeInput, { capture: true });
      };
    }, [handleBeforeInput]);

    const renderPlaceholder = useCallback(
      ({ attributes, children }: RenderPlaceholderProps) => (
        <span {...attributes} className={css.EditorPlaceholderContainer}>
          {/* Inner component to style the actual text position and appearance */}
          <Text as="span" className={css.EditorPlaceholderTextVisual} truncate>
            {children}
          </Text>
        </span>
      ),
      []
    );

    return (
      <div className={css.Editor} ref={ref}>
        <Slate editor={editor} initialValue={initialValue} onChange={onChange}>
          {top}
          <Box alignItems="Start">
            {before && (
              <Box className={css.EditorOptions} alignItems="Center" gap="100" shrink="No">
                {before}
              </Box>
            )}
            <Scroll
              className={css.EditorTextareaScroll}
              variant="SurfaceVariant"
              style={{ maxHeight }}
              size="300"
              visibility="Hover"
              hideTrack
              ref={editableRef}
            >
              <Editable
                data-editable-name={editableName}
                className={css.EditorTextarea}
                placeholder={placeholder}
                renderPlaceholder={renderPlaceholder}
                renderElement={renderElement}
                renderLeaf={renderLeaf}
                decorate={decorate}
                onKeyDown={handleKeydown}
                onKeyUp={onKeyUp}
                onPaste={onPaste}
              />
            </Scroll>
            {after && (
              <Box className={css.EditorOptions} alignItems="Center" gap="100" shrink="No">
                {after}
              </Box>
            )}
          </Box>
          {bottom}
        </Slate>
      </div>
    );
  }
);
