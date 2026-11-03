use crate::ffmpeg;
use crate::models::job::RenderJob;
use crate::utils::event;
use futures::StreamExt;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

pub async fn generate_thumbnails(
    app: &tauri::AppHandle,
    jobs: &mut [RenderJob],
    thumb_dir: &Path,
    control: Arc<crate::RenderControl>,
) {
    // Collect thumbnail tasks: (job_index, input_path, thumb_path)
    let thumb_tasks: Vec<(usize, String, std::path::PathBuf)> = jobs
        .iter()
        .enumerate()
        .map(|(i, j)| {
            let thumb_id = rand::random::<u64>();
            (
                i,
                j.video.input_path.clone(),
                thumb_dir.join(format!("thumb_{}_{}.jpg", thumb_id, i)),
            )
        })
        .collect();

    let stream = futures::stream::iter(thumb_tasks.iter().cloned());

    stream
        .for_each_concurrent(4, |(i, input_path, thumb_path)| {
            let self_app = app.clone();
            let control_clone = control.clone();
            async move {
                if control_clone.is_cancelled() {
                    return;
                }
                if !thumb_path.exists() {
                    let args = build_thumbnail_args(&input_path, &thumb_path);
                    if let Err(e) =
                        ffmpeg::run(&self_app, &args, None, Some(control_clone), None).await
                    {
                        event::emit(
                            &self_app,
                            crate::models::job::PipelineEvent::Log {
                                level: "warn".into(),
                                message: format!("Thumbnail failed for job {}: {}", i, e),
                            },
                        );
                    }
                }
            }
        })
        .await;

    // Map first: the previous `find` inside a loop was O(n²) over the job list
    // (up to 10 000 videos), and `exists()` blocked the async worker.
    let thumbnail_by_index: HashMap<usize, std::path::PathBuf> = thumb_tasks
        .iter()
        .map(|(index, _, path)| (*index, path.clone()))
        .collect();
    for (index, job) in jobs.iter_mut().enumerate() {
        if job.video.thumbnail_path.is_some() {
            continue;
        }
        let Some(thumb_path) = thumbnail_by_index.get(&index) else {
            continue;
        };
        if tokio::fs::metadata(thumb_path).await.is_ok() {
            job.video.thumbnail_path = Some(thumb_path.to_string_lossy().into_owned());
        }
    }
}

fn build_thumbnail_args(input_path: &str, output_path: &Path) -> Vec<String> {
    vec![
        "-y".into(),
        "-ss".into(),
        "00:00:00".into(),
        "-i".into(),
        input_path.to_owned(),
        "-vframes".into(),
        "1".into(),
        "-vf".into(),
        "scale=320:-1".into(),
        output_path.to_string_lossy().into_owned(),
    ]
}

#[cfg(test)]
mod tests {
    use super::build_thumbnail_args;
    use std::path::Path;

    #[test]
    fn thumbnail_args_capture_the_first_frame() {
        let args = build_thumbnail_args(
            r"C:\Users\render\Videos\short clip.mp4",
            Path::new(r"C:\Users\render\Temp\thumb.jpg"),
        );

        assert_eq!(
            args,
            vec![
                "-y",
                "-ss",
                "00:00:00",
                "-i",
                r"C:\Users\render\Videos\short clip.mp4",
                "-vframes",
                "1",
                "-vf",
                "scale=320:-1",
                r"C:\Users\render\Temp\thumb.jpg",
            ]
        );
    }

    #[test]
    fn thumbnail_args_keep_input_and_output_as_separate_arguments() {
        let args = build_thumbnail_args(
            r"C:\Users\render\Videos\clip with spaces.mp4",
            Path::new(r"C:\Users\render\Temp\thumb with spaces.jpg"),
        );

        assert_eq!(args[4], r"C:\Users\render\Videos\clip with spaces.mp4");
        assert_eq!(args[9], r"C:\Users\render\Temp\thumb with spaces.jpg");
        assert!(!args[4].contains('"'));
        assert!(!args[9].contains('"'));
    }
}
