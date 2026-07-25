use crate::ffmpeg;
use crate::models::job::RenderJob;
use crate::utils::event;
use futures::StreamExt;
use std::path::Path;
use std::sync::Arc;

pub async fn generate_thumbnails(
    app: &tauri::AppHandle,
    jobs: &mut [RenderJob],
    thumb_dir: &Path,
    control: Arc<crate::RenderControl>,
) {
    // Collect thumbnail tasks: (job_index, input_path_clone, thumb_id, thumb_path)
    let thumb_tasks: Vec<(usize, String, u64, std::path::PathBuf)> = jobs
        .iter()
        .enumerate()
        .map(|(i, j)| {
            let thumb_id = rand::random::<u64>();
            let thumb_path = thumb_dir.join(format!("thumb_{}_{}.jpg", thumb_id, i));
            (i, j.video.input_path.clone(), thumb_id, thumb_path)
        })
        .collect();

    let stream = futures::stream::iter(thumb_tasks.iter().cloned());

    stream
        .for_each_concurrent(4, |(i, input_path, _thumb_id, thumb_path)| {
            let self_app = app.clone();
            let control_clone = control.clone();
            async move {
                if control_clone.is_cancelled() {
                    return;
                }
                if !thumb_path.exists() {
                    let thumb_path_str = thumb_path.to_string_lossy().into_owned();
                    let args: Vec<&str> = vec![
                        "-y",
                        "-ss",
                        "00:00:01",
                        "-i",
                        &input_path,
                        "-vframes",
                        "1",
                        "-vf",
                        "scale=320:-1",
                        &thumb_path_str,
                    ];
                    if let Err(e) = ffmpeg::run(&self_app, &args, None, Some(control_clone), None).await {
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

    for (i, job) in jobs
        .iter_mut()
        .enumerate()
        .filter(|(_, j)| j.video.thumbnail_path.is_none())
    {
        if let Some((_, _, _, thumb_path)) = thumb_tasks.iter().find(|(idx, _, _, _)| *idx == i)
            && thumb_path.exists()
        {
            job.video.thumbnail_path = Some(thumb_path.to_string_lossy().into_owned());
        }
    }
}
