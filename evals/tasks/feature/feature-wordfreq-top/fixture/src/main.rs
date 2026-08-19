//! wordfreq — count whitespace-separated words on stdin and print
//! `word count` lines, most frequent first (ties alphabetical).

use std::collections::BTreeMap;
use std::io::Read;

fn count_words(input: &str) -> Vec<(String, u64)> {
    let mut counts: BTreeMap<String, u64> = BTreeMap::new();
    for word in input.split_whitespace() {
        *counts.entry(word.to_string()).or_default() += 1;
    }
    let mut out: Vec<(String, u64)> = counts.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

fn main() {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        eprintln!("wordfreq: failed to read stdin");
        std::process::exit(1);
    }
    for (word, count) in count_words(&input) {
        println!("{word} {count}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_orders_by_frequency_then_alphabetically() {
        let out = count_words("b a b c b a");
        assert_eq!(
            out,
            vec![("b".into(), 3), ("a".into(), 2), ("c".into(), 1)]
        );
    }

    #[test]
    fn empty_input_produces_no_rows() {
        assert!(count_words("  \n ").is_empty());
    }
}
