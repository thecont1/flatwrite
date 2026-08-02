# Machine Learning Notes (fixture)

Hypothesis function:

$h_\theta(x) = \theta^T x$

Cost function:

$$
J(\theta) = \frac{1}{2m} \sum_{i=1}^{m} (h_\theta(x^{(i)}) - y^{(i)})^2
$$

Gradient form with TeX delimiters:

\[
\nabla J(\theta) = \frac{1}{m} X^T (X\theta - \vec{y})
\]

Inline paren form: \(\alpha = 0.01\).

Fenced math:

```math
\theta := \theta - \alpha \nabla_\theta J(\theta)
```

Currency (must stay literal even with Math Mode on): the book costs $40.

Code (must stay literal):

```python
theta = theta - alpha * grad  # $ not math
print(f"${price}")
```
