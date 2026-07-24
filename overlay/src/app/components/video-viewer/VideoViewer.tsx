import React from 'react';
import classNames from 'classnames';
import { Box, Chip, Header, IconButton, Text, as } from 'folds';
import { Icon, Icons } from '../icons';
import * as css from './VideoViewer.css';
import { downloadAndSaveMedia } from '../../utils/saveMedia';
import { getCurrentAccessToken } from '../../utils/auth';

export type VideoViewerProps = {
  alt: string;
  src: string;
  requestClose: () => void;
};

export const VideoViewer = as<'div', VideoViewerProps>(
  ({ className, alt, src, requestClose, ...props }, ref) => {
    const handleDownload = async () => {
      try {
        await downloadAndSaveMedia(src, alt, getCurrentAccessToken());
      } catch (error) {
        console.warn('[VideoViewer] Failed to download media:', error);
        try {
          window.open(src, '_blank');
        } catch {
          // ignore
        }
      }
    };

    return (
      <Box
        className={classNames(css.VideoViewer, className)}
        direction="Column"
        {...props}
        ref={ref}
      >
        <Header className={css.VideoViewerHeader} size="400">
          <Box grow="Yes" alignItems="Center" gap="200">
            <IconButton size="300" radii="300" onClick={requestClose}>
              <Icon size="50" src={Icons.ArrowLeft} />
            </IconButton>
            <Text size="T300" truncate>
              {alt}
            </Text>
          </Box>
          <Box shrink="No" alignItems="Center" gap="200">
            <Chip
              variant="Primary"
              onClick={handleDownload}
              radii="300"
              before={<Icon size="50" src={Icons.Download} />}
            >
              <Text size="B300">Download</Text>
            </Chip>
          </Box>
        </Header>
        <Box
          grow="Yes"
          className={css.VideoViewerContent}
          justifyContent="Center"
          alignItems="Center"
        >
          <video
            className={css.VideoViewerVideo}
            src={src}
            title={alt}
            controls
            autoPlay
          />
        </Box>
      </Box>
    );
  }
);
