//! Sentence pooling over a padded batch. `mask` is (batch, seq) with 1 for
//! real tokens.

use candle_core::{IndexOp, Result, Tensor, D};

use crate::spec::Pooling;

pub fn pool(hidden: &Tensor, mask: &Tensor, pooling: Pooling) -> Result<Tensor> {
    match pooling {
        Pooling::Cls => hidden.i((.., 0, ..)),
        Pooling::Mean => {
            let m = mask.to_dtype(hidden.dtype())?.unsqueeze(2)?;
            let summed = hidden.broadcast_mul(&m)?.sum(1)?;
            let counts = m.sum(1)?.clamp(1e-9, f64::MAX)?;
            summed.broadcast_div(&counts)
        }
    }
}

pub fn l2_normalize(x: &Tensor) -> Result<Tensor> {
    let norm = x
        .sqr()?
        .sum_keepdim(D::Minus1)?
        .sqrt()?
        .clamp(1e-12, f64::MAX)?;
    x.broadcast_div(&norm)
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::{Device, Tensor};

    fn hidden() -> Tensor {
        // batch 2, seq 3, dim 2. Row 1's last token is padding (mask 0).
        Tensor::new(
            &[
                [[1f32, 0.], [3., 0.], [9., 9.]],
                [[0f32, 2.], [0., 4.], [0., 6.]],
            ],
            &Device::Cpu,
        )
        .unwrap()
    }

    fn mask() -> Tensor {
        Tensor::new(&[[1u32, 1, 0], [1, 1, 1]], &Device::Cpu).unwrap()
    }

    #[test]
    fn masked_pooling_ignores_padding() {
        let mean = pool(&hidden(), &mask(), Pooling::Mean)
            .unwrap()
            .to_vec2::<f32>()
            .unwrap();
        assert_eq!(mean, vec![vec![2.0, 0.0], vec![0.0, 4.0]]);
        let cls = pool(&hidden(), &mask(), Pooling::Cls)
            .unwrap()
            .to_vec2::<f32>()
            .unwrap();
        assert_eq!(cls, vec![vec![1.0, 0.0], vec![0.0, 2.0]]);
    }

    #[test]
    fn l2_normalize_makes_unit_rows() {
        let n = l2_normalize(&Tensor::new(&[[3f32, 4.]], &Device::Cpu).unwrap())
            .unwrap()
            .to_vec2::<f32>()
            .unwrap();
        assert_eq!(n, vec![vec![0.6, 0.8]]);
    }
}
