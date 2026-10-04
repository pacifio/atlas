//! Retrieval quality on a question set: R@5, R@10, MRR and nDCG@10 per method.
//! Usage: cargo run -p atlas-codeindex --release --example eval_retrieval -- <repo> <questions.jsonl> [model_dir]
use std::path::Path;

use atlas_codeindex::{CodeIndex, SemanticQuery};

struct Emb(atlas_embed::Embedder, String);
impl atlas_codeindex::Embedder for Emb {
    fn model_id(&self) -> &str {
        &self.1
    }
    fn dims(&self) -> usize {
        self.0.dim()
    }
    fn embed_documents(&self, t: &[&str]) -> Result<Vec<Vec<f32>>, String> {
        self.0.embed_documents(t).map_err(|e| e.to_string())
    }
    fn embed_query(&self, t: &str) -> Result<Vec<f32>, String> {
        self.0.embed_query(t).map_err(|e| e.to_string())
    }
}

fn metrics(ranked: &[String], gold: &[String]) -> (f64, f64, f64, f64, Option<usize>) {
    let pos = ranked.iter().position(|f| gold.contains(f));
    let r5 = pos.is_some_and(|p| p < 5) as u8 as f64;
    let r10 = pos.is_some_and(|p| p < 10) as u8 as f64;
    let mrr = pos.map_or(0.0, |p| 1.0 / (p as f64 + 1.0));
    let ndcg = pos
        .filter(|&p| p < 10)
        .map_or(0.0, |p| 1.0 / (p as f64 + 2.0).log2());
    (r5, r10, mrr, ndcg, pos)
}

fn files(hits: Vec<atlas_codeindex::ChunkHit>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for h in hits {
        if !out.contains(&h.rel) {
            out.push(h.rel);
        }
    }
    out
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let ix = CodeIndex::open(Path::new(&a[1])).unwrap();
    ix.full_build(&atlas_search::CancelToken::new(), &|_| {})
        .unwrap();
    let emb = a.get(3).map(|d| {
        Emb(
            atlas_embed::Embedder::load(Path::new(d)).unwrap(),
            Path::new(d)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        )
    });
    if let Some(e) = &emb {
        let t = std::time::Instant::now();
        let s = ix
            .sync_vectors(e, &atlas_search::CancelToken::new())
            .unwrap();
        println!(
            "embedded {} chunks in {:.1}s ({} backend)",
            s.embedded,
            t.elapsed().as_secs_f64(),
            e.0.backend()
        );
    }
    let qs: Vec<serde_json::Value> = std::fs::read_to_string(&a[2])
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let ix = &ix; // closures below borrow the index; `move` copies this reference
    let mut methods: Vec<(&str, Box<dyn Fn(&str) -> Vec<String> + '_>)> = vec![(
        "hybrid (no dense)",
        Box::new(|q: &str| {
            files(
                ix.semantic_search(
                    &SemanticQuery {
                        query: q.into(),
                        limit: 20,
                        ..Default::default()
                    },
                    None,
                )
                .unwrap()
                .0,
            )
        }),
    )];
    if let Some(e) = &emb {
        methods.push((
            "hybrid (+dense)",
            Box::new(move |q: &str| {
                files(
                    ix.semantic_search(
                        &SemanticQuery {
                            query: q.into(),
                            limit: 20,
                            ..Default::default()
                        },
                        Some(e),
                    )
                    .unwrap()
                    .0,
                )
            }),
        ));
    }
    for (name, run) in &methods {
        let mut sum = (0.0, 0.0, 0.0, 0.0);
        let mut ranks = Vec::new();
        for v in &qs {
            let gold: Vec<String> = v["gold"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g.as_str().unwrap().to_string())
                .collect();
            let m = metrics(&run(v["q"].as_str().unwrap()), &gold);
            sum = (sum.0 + m.0, sum.1 + m.1, sum.2 + m.2, sum.3 + m.3);
            ranks.push(m.4.map_or("-".to_string(), |p| (p + 1).to_string()));
        }
        let n = qs.len() as f64;
        println!(
            "{name:20} R@5 {:.2}  R@10 {:.2}  MRR {:.3}  nDCG@10 {:.3}",
            sum.0 / n,
            sum.1 / n,
            sum.2 / n,
            sum.3 / n
        );
        // Rank of the first gold file per question, in file order ("-" = not found), for comparing models question by question.
        println!("{:20} ranks {}", "", ranks.join(" "));
    }
}
